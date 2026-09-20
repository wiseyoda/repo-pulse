import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024
const MAX_UNTRACKED_COUNTED = 2000
const MAX_COUNT_BYTES = 4 * 1024 * 1024
const READ_CONCURRENCY = 32
/** Observe only: never refresh the index or take index.lock, so agents' own git commands are never blocked. */
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

export interface FileStat {
  path: string
  status: FileStatus
  added: number
  deleted: number
  binary: boolean
  from?: string
}

export interface Worktree {
  id: string
  path: string
  head: string | null
  branch: string | null
}

export interface CommitFile {
  path: string
  added: number
  deleted: number
  binary: boolean
}

export interface Commit {
  sha: string
  ts: number
  author: string
  subject: string
  refs: string
  files: CommitFile[]
  added: number
  deleted: number
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
    env: GIT_ENV,
  })
  return stdout
}

/** Returns stdout even on non-zero exit; `git diff --no-index` exits 1 when files differ. */
export async function gitLenient(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch (err) {
    const e = err as { stdout?: unknown }
    if (typeof e.stdout === 'string') return e.stdout
    throw err
  }
}

// --- parsers (pure) ---------------------------------------------------------

export interface NumstatEntry {
  path: string
  from?: string
  added: number
  deleted: number
  binary: boolean
}

/** Parse `git diff --numstat -z`. Renames arrive as `A\tD\t\0old\0new\0`. */
export function parseNumstatZ(raw: string): NumstatEntry[] {
  const tokens = raw.split('\0')
  const out: NumstatEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token)
    if (!m) continue
    const binary = m[1] === '-'
    const added = binary ? 0 : Number(m[1])
    const deleted = binary ? 0 : Number(m[2])
    if (m[3] === '') {
      const from = tokens[++i] ?? ''
      const to = tokens[++i] ?? ''
      out.push({ path: to, from, added, deleted, binary })
    } else {
      out.push({ path: m[3] ?? '', added, deleted, binary })
    }
  }
  return out
}

export interface NameStatusEntry {
  path: string
  from?: string
  status: FileStatus
}

/** Parse `git diff --name-status -z`. R/C records carry two paths. */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const tokens = raw.split('\0')
  const out: NameStatusEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    if (!code) continue
    const letter = code[0] ?? ''
    if (letter === 'R' || letter === 'C') {
      const from = tokens[++i] ?? ''
      const to = tokens[++i] ?? ''
      out.push(
        letter === 'R' ? { path: to, from, status: 'renamed' } : { path: to, status: 'added' },
      )
      continue
    }
    const p = tokens[++i] ?? ''
    const status: FileStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
    out.push({ path: p, status })
  }
  return out
}

/** Parse `git log --format=%x1e%H%x1f%at%x1f%an%x1f%s%x1f%D --numstat`. */
export function parseLog(raw: string): Commit[] {
  const out: Commit[] = []
  for (const record of raw.split('\x1e')) {
    if (!record.trim()) continue
    const lines = record.split('\n')
    const header = (lines[0] ?? '').split('\x1f')
    const sha = header[0] ?? ''
    if (!sha) continue
    const files: CommitFile[] = []
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue
      const [a, d, p] = line.split('\t')
      if (p === undefined) continue
      const binary = a === '-'
      files.push({
        path: p,
        added: binary ? 0 : Number(a),
        deleted: binary ? 0 : Number(d),
        binary,
      })
    }
    out.push({
      sha,
      ts: Number(header[1] ?? 0) * 1000,
      author: header[2] ?? '',
      subject: header[3] ?? '',
      refs: header[4] ?? '',
      files,
      added: files.reduce((n, f) => n + f.added, 0),
      deleted: files.reduce((n, f) => n + f.deleted, 0),
    })
  }
  return out
}

export function parseWorktreeList(raw: string): Omit<Worktree, 'id'>[] {
  const out: Omit<Worktree, 'id'>[] = []
  for (const block of raw.split('\n\n')) {
    let wtPath = ''
    let head: string | null = null
    let branch: string | null = null
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch '))
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
    if (wtPath) out.push({ path: wtPath, head, branch })
  }
  return out
}

export function worktreeId(wtPath: string): string {
  return createHash('sha1').update(wtPath).digest('hex').slice(0, 8)
}

// --- repo queries -----------------------------------------------------------

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
}

export async function gitDir(cwd: string): Promise<string> {
  const dir = (await git(cwd, ['rev-parse', '--git-dir'])).trim()
  return path.resolve(cwd, dir)
}

/** The shared `.git` of a repo; identical for every worktree, so it identifies the repo. */
export async function commonDir(cwd: string): Promise<string> {
  const dir = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()
  return path.resolve(cwd, dir)
}

export async function headSha(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const raw = await git(cwd, ['worktree', 'list', '--porcelain'])
  return parseWorktreeList(raw).map((w) => ({ id: worktreeId(w.path), ...w }))
}

export interface LineCount {
  lines: number
  binary: boolean
}

/** Remembers line counts by (size, mtime) so an idle untracked file costs one stat per tick, not a read. */
export class LineCountCache {
  private entries = new Map<string, { size: number; mtimeMs: number; count: LineCount }>()

  async count(file: string): Promise<LineCount> {
    let size: number
    let mtimeMs: number
    try {
      const st = await stat(file)
      if (!st.isFile()) return { lines: 0, binary: false }
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      this.entries.delete(file)
      return { lines: 0, binary: false }
    }
    const hit = this.entries.get(file)
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.count
    const count = await countLines(file)
    this.entries.set(file, { size, mtimeMs, count })
    return count
  }

  /** Drop entries for files git no longer reports, so the cache tracks the working tree. */
  retain(files: Iterable<string>): void {
    const keep = new Set(files)
    for (const k of this.entries.keys()) if (!keep.has(k)) this.entries.delete(k)
  }
}

async function countLines(file: string): Promise<LineCount> {
  let handle
  try {
    handle = await open(file, 'r')
    const buf = Buffer.alloc(MAX_COUNT_BYTES)
    const { bytesRead } = await handle.read(buf, 0, MAX_COUNT_BYTES, 0)
    const head = buf.subarray(0, Math.min(bytesRead, 8000))
    if (head.includes(0)) return { lines: 0, binary: true }
    let lines = 0
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) lines++
    if (bytesRead > 0 && buf[bytesRead - 1] !== 10) lines++
    return { lines, binary: false }
  } catch {
    return { lines: 0, binary: false }
  } finally {
    await handle?.close()
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return results
}

/** Every file that differs from HEAD (staged or not) plus untracked files, with line counts. */
export async function readWorkingTree(
  cwd: string,
  head: string | null,
  cache: LineCountCache = new LineCountCache(),
): Promise<Map<string, FileStat>> {
  const files = new Map<string, FileStat>()
  if (head) {
    const [numRaw, nameRaw] = await Promise.all([
      git(cwd, ['diff', 'HEAD', '-M', '--numstat', '-z', '--']),
      git(cwd, ['diff', 'HEAD', '-M', '--name-status', '-z', '--']),
    ])
    const statusByPath = new Map(parseNameStatusZ(nameRaw).map((e) => [e.path, e]))
    for (const n of parseNumstatZ(numRaw)) {
      const s = statusByPath.get(n.path)
      const stat: FileStat = {
        path: n.path,
        status: s?.status ?? 'modified',
        added: n.added,
        deleted: n.deleted,
        binary: n.binary,
      }
      if (n.from) stat.from = n.from
      files.set(n.path, stat)
    }
  }
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
  const counted = untracked.slice(0, MAX_UNTRACKED_COUNTED)
  const abs = counted.map((p) => path.join(cwd, p))
  const counts = await mapPool(abs, READ_CONCURRENCY, (f) => cache.count(f))
  cache.retain(abs)
  counted.forEach((p, i) => {
    const c = counts[i] ?? { lines: 0, binary: false }
    files.set(p, { path: p, status: 'untracked', added: c.lines, deleted: 0, binary: c.binary })
  })
  for (const p of untracked.slice(MAX_UNTRACKED_COUNTED)) {
    files.set(p, { path: p, status: 'untracked', added: 0, deleted: 0, binary: false })
  }
  return files
}

const LOG_FORMAT = '--format=%x1e%H%x1f%at%x1f%an%x1f%s%x1f%D'

export async function readCommits(cwd: string, range: string[]): Promise<Commit[]> {
  const raw = await git(cwd, ['log', LOG_FORMAT, '--numstat', '-M', '--no-color', ...range, '--'])
  return parseLog(raw)
}

/** Commits reachable from `to` but not `from`. Empty when history was rewritten or reset. */
export async function commitsBetween(
  cwd: string,
  from: string | null,
  to: string,
): Promise<Commit[]> {
  if (!from) return readCommits(cwd, ['-n', '20', to])
  try {
    return await readCommits(cwd, [`${from}..${to}`])
  } catch {
    return []
  }
}

export async function fileDiff(cwd: string, file: FileStat): Promise<string> {
  if (file.status === 'untracked') {
    return gitLenient(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', file.path])
  }
  const paths = file.from ? [file.from, file.path] : [file.path]
  return git(cwd, ['diff', 'HEAD', '-M', '--no-color', '--', ...paths])
}

export async function commitPatch(cwd: string, sha: string): Promise<string> {
  return git(cwd, [
    'show',
    '--no-color',
    '--format=%H%n%an <%ae>%n%ad%n%n%s%n%n%b',
    '--stat',
    '--patch',
    '-M',
    sha,
    '--',
  ])
}

export interface ExtCount {
  ext: string
  n: number
}

/** Tracked files by extension, cheap enough to call on demand: one `ls-files`, no reads. */
export async function fileMix(cwd: string): Promise<{ total: number; byExt: ExtCount[] }> {
  const files = (await git(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean)
  const counts = new Map<string, number>()
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase()
    counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
  return { total: files.length, byExt: [...counts].map(([ext, n]) => ({ ext, n })) }
}
