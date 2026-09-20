import { describe, expect, it } from 'vitest'
import { diffWorkingTrees } from '../src/delta.ts'
import type { FileStat } from '../src/git.ts'

const snap = (...files: FileStat[]) => new Map(files.map((f) => [f.path, f]))
const f = (path: string, over: Partial<FileStat> = {}): FileStat => ({
  path,
  status: 'modified',
  added: 0,
  deleted: 0,
  binary: false,
  ...over,
})

describe('diffWorkingTrees', () => {
  it('reports a new untracked file as created with its full size', () => {
    const out = diffWorkingTrees(
      snap(),
      snap(f('a.py', { status: 'untracked', added: 40 })),
      new Set(),
    )
    expect(out).toEqual([
      expect.objectContaining({
        path: 'a.py',
        kind: 'created',
        dAdded: 40,
        dDeleted: 0,
        added: 40,
      }),
    ])
  })

  it('reports growth of an already-modified file as a delta', () => {
    const out = diffWorkingTrees(
      snap(f('a.py', { added: 10, deleted: 2 })),
      snap(f('a.py', { added: 25, deleted: 3 })),
      new Set(),
    )
    expect(out).toEqual([
      expect.objectContaining({ kind: 'modified', dAdded: 15, dDeleted: 1, added: 25, deleted: 3 }),
    ])
  })

  it('stays silent when nothing changed and the file was not touched', () => {
    const a = snap(f('a.py', { added: 10 }))
    expect(diffWorkingTrees(a, snap(f('a.py', { added: 10 })), new Set())).toEqual([])
  })

  it('still reports a touched file whose numstat did not move', () => {
    const a = snap(f('a.py', { added: 10 }))
    const out = diffWorkingTrees(a, snap(f('a.py', { added: 10 })), new Set(['a.py']))
    expect(out).toEqual([expect.objectContaining({ kind: 'modified', dAdded: 0, dDeleted: 0 })])
  })

  it('reports a tracked file that matches HEAD again as reverted', () => {
    const out = diffWorkingTrees(snap(f('a.py', { added: 10, deleted: 4 })), snap(), new Set())
    expect(out).toEqual([
      expect.objectContaining({ kind: 'reverted', dAdded: -10, dDeleted: -4, added: 0 }),
    ])
  })

  it('reports a removed untracked file as deleted', () => {
    const out = diffWorkingTrees(
      snap(f('tmp.txt', { status: 'untracked', added: 3 })),
      snap(),
      new Set(),
    )
    expect(out).toEqual([expect.objectContaining({ kind: 'deleted', dAdded: -3 })])
  })

  it('reports a tracked file deleted from disk', () => {
    const out = diffWorkingTrees(
      snap(),
      snap(f('gone.py', { status: 'deleted', deleted: 50 })),
      new Set(),
    )
    expect(out).toEqual([expect.objectContaining({ kind: 'deleted', dDeleted: 50 })])
  })

  it('carries the old name through a rename', () => {
    const out = diffWorkingTrees(
      snap(),
      snap(f('new.md', { status: 'renamed', from: 'old.md', added: 2 })),
      new Set(),
    )
    expect(out).toEqual([expect.objectContaining({ kind: 'renamed', from: 'old.md' })])
  })

  it('sorts output by path', () => {
    const out = diffWorkingTrees(snap(), snap(f('b'), f('a')), new Set())
    expect(out.map((d) => d.path)).toEqual(['a', 'b'])
  })
})
