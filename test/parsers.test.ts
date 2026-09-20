import { describe, expect, it } from 'vitest'
import { parseLog, parseNameStatusZ, parseNumstatZ, parseWorktreeList } from '../src/git.ts'

describe('parseNumstatZ', () => {
  it('parses plain, binary, and rename records', () => {
    const raw = '9\t1\tsrc/a.ts\x00-\t-\timg.png\x008\t3\t\x00briefs/old.md\x00briefs/new.md\x00'
    expect(parseNumstatZ(raw)).toEqual([
      { path: 'src/a.ts', added: 9, deleted: 1, binary: false },
      { path: 'img.png', added: 0, deleted: 0, binary: true },
      { path: 'briefs/new.md', from: 'briefs/old.md', added: 8, deleted: 3, binary: false },
    ])
  })
  it('handles empty input', () => {
    expect(parseNumstatZ('')).toEqual([])
  })
})

describe('parseNameStatusZ', () => {
  it('maps codes and reads two paths for renames and copies', () => {
    const raw = 'M\0a.ts\0A\0b.ts\0D\0c.ts\0R100\0old.md\0new.md\0C75\0x.ts\0y.ts\0'
    expect(parseNameStatusZ(raw)).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
      { path: 'c.ts', status: 'deleted' },
      { path: 'new.md', from: 'old.md', status: 'renamed' },
      { path: 'y.ts', status: 'added' },
    ])
  })
})

describe('parseLog', () => {
  it('parses records with numstat bodies', () => {
    const raw =
      '\x1eabc123\x1f1789881506\x1fwiseyoda\x1ffeat(acquire): fetchers (W-009)\x1fHEAD -> main\n' +
      '3\t2\tWORK.md\n-\t-\tlogo.png\n\n' +
      '\x1edef456\x1f1789881000\x1fwiseyoda\x1fdocs: notes\x1f\n' +
      '\n'
    const commits = parseLog(raw)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toMatchObject({
      sha: 'abc123',
      ts: 1789881506000,
      author: 'wiseyoda',
      subject: 'feat(acquire): fetchers (W-009)',
      refs: 'HEAD -> main',
      added: 3,
      deleted: 2,
    })
    expect(commits[0]?.files).toEqual([
      { path: 'WORK.md', added: 3, deleted: 2, binary: false },
      { path: 'logo.png', added: 0, deleted: 0, binary: true },
    ])
    expect(commits[1]).toMatchObject({ sha: 'def456', files: [], added: 0, deleted: 0 })
  })
})

describe('parseWorktreeList', () => {
  it('reads main and linked worktrees', () => {
    const raw =
      'worktree /r\nHEAD 0039acc\nbranch refs/heads/main\n\n' +
      'worktree /r/.worktrees/x\nHEAD a1a2574\ndetached\n\n'
    expect(parseWorktreeList(raw)).toEqual([
      { path: '/r', head: '0039acc', branch: 'main' },
      { path: '/r/.worktrees/x', head: 'a1a2574', branch: null },
    ])
  })
})
