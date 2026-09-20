import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commitsBetween,
  fileDiff,
  headSha,
  listWorktrees,
  readCommits,
  readWorkingTree,
} from '../src/git.ts'

let repo: string
const run = (args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'repo-pulse-'))
  run(['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n')
  mkdirSync(path.join(repo, 'src'))
  writeFileSync(path.join(repo, 'src/a.py'), 'one\ntwo\nthree\n')
  writeFileSync(
    path.join(repo, 'src/old.md'),
    Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n',
  )
  writeFileSync(path.join(repo, 'src/gone.py'), 'x\ny\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'init (W-001)'])
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('readWorkingTree against a real repo', () => {
  it('sees modified, untracked, deleted, and renamed files while ignoring ignored ones', async () => {
    writeFileSync(path.join(repo, 'src/a.py'), 'one\nTWO\nthree\nfour\n')
    writeFileSync(path.join(repo, 'src/new.py'), 'a\nb\nc')
    mkdirSync(path.join(repo, 'ignored'))
    writeFileSync(path.join(repo, 'ignored/noise.txt'), 'zzz\n')
    unlinkSync(path.join(repo, 'src/gone.py'))
    renameSync(path.join(repo, 'src/old.md'), path.join(repo, 'src/renamed.md'))
    run(['add', '-A', 'src/old.md', 'src/renamed.md'])
    writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]))

    const head = await headSha(repo)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
    const files = await readWorkingTree(repo, head)

    expect(files.get('src/a.py')).toMatchObject({ status: 'modified', added: 2, deleted: 1 })
    expect(files.get('src/new.py')).toMatchObject({ status: 'untracked', added: 3 })
    expect(files.get('src/gone.py')).toMatchObject({ status: 'deleted', deleted: 2 })
    expect(files.get('src/renamed.md')).toMatchObject({ status: 'renamed', from: 'src/old.md' })
    expect(files.get('bin.dat')).toMatchObject({ status: 'untracked', binary: true })
    expect(files.has('ignored/noise.txt')).toBe(false)
  })

  it('produces a diff for tracked and untracked files', async () => {
    const files = await readWorkingTree(repo, await headSha(repo))
    expect(await fileDiff(repo, files.get('src/a.py')!)).toContain('+TWO')
    expect(await fileDiff(repo, files.get('src/new.py')!)).toContain('+a')
  })

  it('lists commits with numstat and finds new commits between heads', async () => {
    const before = await headSha(repo)
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'feat: change things (W-002)'])
    const after = await headSha(repo)
    const fresh = await commitsBetween(repo, before, after!)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toMatchObject({ subject: 'feat: change things (W-002)', author: 't' })
    expect(fresh[0]?.files.map((f) => f.path)).toContain('src/a.py')
    expect(await readCommits(repo, ['-n', '10'])).toHaveLength(2)
  })

  it('lists worktrees', async () => {
    const wts = await listWorktrees(repo)
    expect(wts).toHaveLength(1)
    expect(wts[0]).toMatchObject({ branch: 'main' })
    expect(wts[0]?.id).toMatch(/^[0-9a-f]{8}$/)
  })
})
