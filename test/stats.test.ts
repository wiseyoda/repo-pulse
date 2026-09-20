import { describe, expect, it } from 'vitest'
import {
  bucketActivity,
  bucketFor,
  churnBy,
  commitTypes,
  compact,
  extMix,
  isTestPath,
  sizeTrend,
  tempo,
  testShare,
} from '../public/lib.js'

const edit = (ts: number, path: string, dAdded = 0, dDeleted = 0) => ({
  ts,
  path,
  dAdded,
  dDeleted,
})

describe('bucketActivity', () => {
  it('covers the whole window and files reverts as deletions', () => {
    const since = 17 * 60_000 // bucket-aligned
    const now = since + 5 * 60_000 - 1
    const out = bucketActivity(
      [edit(since + 10, 'a', 5, 1), edit(since + 61_000, 'a', -5, 0)],
      [{ ts: since + 61_500 }],
      since,
      now,
      60_000,
    )
    expect(out).toHaveLength(5)
    expect(out[0]).toMatchObject({ added: 5, deleted: 1, edits: 1, commits: 0 })
    expect(out[1]).toMatchObject({ added: 0, deleted: 5, edits: 1, commits: 1 })
    expect(out[4]).toMatchObject({ added: 0, deleted: 0, edits: 0 })
  })
  it('picks a bucket that yields a readable column count', () => {
    expect(bucketFor(15 * 60_000)).toBe(15_000)
    expect(bucketFor(24 * 3_600_000)).toBe(20 * 60_000)
    expect(bucketFor(0)).toBe(3_600_000)
  })
})

describe('isTestPath', () => {
  it('recognises test layouts across ecosystems', () => {
    for (const p of [
      'tests/x4/test_limits.py',
      'src/a/__tests__/b.tsx',
      'lib/a.spec.ts',
      'foo/bar_test.go',
      'test/lib.test.ts',
      'spec/models/user_spec.rb',
      'tests/conftest.py',
    ])
      expect(isTestPath(p), p).toBe(true)
    for (const p of ['src/testing_tools.py', 'contest/index.js', 'src/latest.ts', 'README.md'])
      expect(isTestPath(p), p).toBe(false)
  })
  it('gives the share of changed lines that landed in tests', () => {
    expect(testShare([edit(0, 'tests/a.py', 30, 0), edit(0, 'src/a.py', 10, 0)])).toEqual({
      test: 30,
      other: 10,
      share: 0.75,
    })
  })
})

describe('churnBy', () => {
  it('groups by top directory, largest first, and counts distinct files', () => {
    const out = churnBy([
      edit(0, 'src/a.py', 1, 0),
      edit(0, 'src/b.py', 3, 0),
      edit(0, 'tests/t.py', 10, 2),
      edit(0, 'README.md', 1, 1),
    ])
    expect(out.map((g) => g.key)).toEqual(['tests', 'src', '·'])
    expect(out[1]).toMatchObject({ added: 4, files: 2, edits: 2, total: 4 })
  })
})

describe('commit helpers', () => {
  it('counts conventional commit types with scopes and breaking marks', () => {
    const out = commitTypes([
      { subject: 'feat(api): x' },
      { subject: 'feat!: y' },
      { subject: 'fix: z' },
      { subject: 'Merge branch' },
    ])
    expect(out).toEqual([
      { type: 'feat', n: 2 },
      { type: 'fix', n: 1 },
      { type: 'other', n: 1 },
    ])
  })
  it('accumulates net size oldest first', () => {
    expect(
      sizeTrend([
        { ts: 2, added: 5, deleted: 1, sha: 'b' },
        { ts: 1, added: 10, deleted: 0, sha: 'a' },
      ]),
    ).toEqual([
      { ts: 1, net: 10, sha: 'a' },
      { ts: 2, net: 14, sha: 'b' },
    ])
  })
})

describe('tempo', () => {
  it('counts active minutes and finds the longest quiet gap', () => {
    const since = 60_000 * 100
    const now = since + 10 * 60_000
    const out = tempo(
      [edit(since + 1000, 'a'), edit(since + 1500, 'a'), edit(since + 7 * 60_000, 'a')],
      [],
      since,
      now,
    )
    expect(out.activeMinutes).toBe(2)
    expect(out.gapMs).toBeCloseTo(7 * 60_000 - 1500, -2)
    expect(out.busiest).toEqual({ minute: since, edits: 2 })
  })
})

describe('extMix / compact', () => {
  it('keeps the top extensions and folds the rest', () => {
    const out = extMix(
      [
        { ext: 'py', n: 60 },
        { ext: 'md', n: 20 },
        { ext: 'ts', n: 10 },
        { ext: 'json', n: 10 },
      ],
      2,
    )
    expect(out.map((x) => x.ext)).toEqual(['py', 'md', 'other'])
    expect(out[2]).toMatchObject({ n: 20, share: 0.2 })
  })
  it('compacts big numbers', () => {
    expect(compact(1284)).toBe('1,284')
    expect(compact(12_900)).toBe('12.9K')
    expect(compact(-1_234_567)).toBe('-1.2M')
  })
})
