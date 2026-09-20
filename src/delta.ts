import type { FileStat, FileStatus } from './git.ts'

export type EditKind = 'created' | 'modified' | 'deleted' | 'reverted' | 'renamed'

export interface EditDelta {
  path: string
  kind: EditKind
  status: FileStatus
  /** Change in lines-added-vs-HEAD since the previous snapshot. Can be negative. */
  dAdded: number
  dDeleted: number
  added: number
  deleted: number
  binary: boolean
  from?: string
}

function kindForNew(stat: FileStat): EditKind {
  switch (stat.status) {
    case 'untracked':
    case 'added':
      return 'created'
    case 'deleted':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    default:
      return 'modified'
  }
}

/**
 * Turn two working-tree snapshots into edit events. `touched` is the set of paths the
 * filesystem watcher saw between the snapshots; it lets a rewrite that keeps the numstat
 * identical (editing an already-changed line) still register as an edit.
 */
export function diffWorkingTrees(
  prev: Map<string, FileStat>,
  next: Map<string, FileStat>,
  touched: Set<string>,
): EditDelta[] {
  const out: EditDelta[] = []
  for (const [p, cur] of next) {
    const old = prev.get(p)
    if (!old) {
      const d: EditDelta = {
        path: p,
        kind: kindForNew(cur),
        status: cur.status,
        dAdded: cur.added,
        dDeleted: cur.deleted,
        added: cur.added,
        deleted: cur.deleted,
        binary: cur.binary,
      }
      if (cur.from) d.from = cur.from
      out.push(d)
      continue
    }
    const sameStats =
      old.added === cur.added && old.deleted === cur.deleted && old.status === cur.status
    if (sameStats && !touched.has(p)) continue
    const kind: EditKind =
      cur.status === 'deleted' && old.status !== 'deleted'
        ? 'deleted'
        : cur.status === 'renamed' && old.status !== 'renamed'
          ? 'renamed'
          : 'modified'
    const d: EditDelta = {
      path: p,
      kind,
      status: cur.status,
      dAdded: cur.added - old.added,
      dDeleted: cur.deleted - old.deleted,
      added: cur.added,
      deleted: cur.deleted,
      binary: cur.binary,
    }
    if (cur.from) d.from = cur.from
    out.push(d)
  }
  for (const [p, old] of prev) {
    if (next.has(p)) continue
    // Gone from the diff: an untracked file was removed, or a tracked file matches HEAD again.
    out.push({
      path: p,
      kind: old.status === 'untracked' ? 'deleted' : 'reverted',
      status: old.status,
      dAdded: -old.added,
      dDeleted: -old.deleted,
      added: 0,
      deleted: 0,
      binary: old.binary,
    })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
