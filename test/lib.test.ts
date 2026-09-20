import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ITEM_PATTERN,
  extractItems,
  feedTotals,
  magnitudeWidth,
  mergeFeed,
  numberDiff,
  relativeTime,
  rollupCommits,
} from '../public/lib.js'

const commit = (subject: string, ts: number, added = 0, deleted = 0, paths: string[] = []) => ({
  sha: subject,
  subject,
  ts,
  added,
  deleted,
  files: paths.map((path) => ({ path, added: 0, deleted: 0, binary: false })),
})

describe('extractItems', () => {
  it('finds ids like W-032 and D-43, once each', () => {
    expect(extractItems('docs: X4 spike (W-025), D-42, W-025 again', DEFAULT_ITEM_PATTERN)).toEqual(
      ['W-025', 'D-42'],
    )
  })
  it('ignores lowercase and bare numbers', () => {
    expect(extractItems('fix w-1 and 2026-09', DEFAULT_ITEM_PATTERN)).toEqual([])
  })
})

describe('rollupCommits', () => {
  it('groups by item, counts a two-item commit toward both, buckets the rest', () => {
    const rows = rollupCommits(
      [
        commit('feat: a (W-009)', 300, 10, 1, ['a', 'b']),
        commit('docs: b (W-009, D-43)', 200, 5, 0, ['b']),
        commit('chore: no id', 100, 1, 1, ['c']),
        commit('old (W-001)', 5),
      ],
      DEFAULT_ITEM_PATTERN,
      50,
    )
    expect(rows.map((r) => r.item)).toEqual(['W-009', 'D-43', 'unlabeled'])
    expect(rows[0]).toMatchObject({ commits: 2, added: 15, deleted: 1, files: 2, last: 300 })
    expect(rows[1]).toMatchObject({ commits: 1, files: 1 })
  })
})

describe('magnitudeWidth', () => {
  it('is zero for nothing, grows slowly, and caps', () => {
    expect(magnitudeWidth(0)).toBe(0)
    expect(magnitudeWidth(1)).toBe(6)
    expect(magnitudeWidth(100)).toBeLessThan(magnitudeWidth(1000))
    expect(magnitudeWidth(1_000_000)).toBe(64)
  })
})

describe('relativeTime', () => {
  it('formats compactly', () => {
    const now = 1_000_000_000
    expect(relativeTime(now - 2000, now)).toBe('now')
    expect(relativeTime(now - 45_000, now)).toBe('45s')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3d')
  })
})

describe('mergeFeed', () => {
  it('interleaves newest first and drops rows before the window', () => {
    const rows = mergeFeed(
      [
        { id: 1, ts: 10 },
        { id: 2, ts: 30 },
      ],
      [{ id: 3, ts: 20 }],
      [],
      15,
    )
    expect(rows.map((r) => r.id)).toEqual([2, 3])
  })
})

describe('numberDiff', () => {
  it('numbers context, added, and deleted lines from the hunk header', () => {
    const text = [
      'diff --git a/src/a.py b/src/a.py',
      'index 1..2 100644',
      '--- a/src/a.py',
      '+++ b/src/a.py',
      '@@ -10,3 +10,4 @@ def f():',
      ' one',
      '-two',
      '+TWO',
      '+three',
      ' four',
    ].join('\n')
    const lines = numberDiff(text)
    expect(lines[0]).toMatchObject({ cls: 'file', path: 'src/a.py' })
    expect(lines[1]?.cls).toBe('meta')
    expect(lines[4]?.cls).toBe('hunk')
    expect(lines.slice(5)).toEqual([
      { cls: 'ctx', old: 10, new: 10, text: ' one' },
      { cls: 'del', old: 11, at: 11, text: '-two' },
      { cls: 'add', new: 11, text: '+TWO' },
      { cls: 'add', new: 12, text: '+three' },
      { cls: 'ctx', old: 12, new: 13, text: ' four' },
    ])
  })
  it('leaves a commit header and stat block unnumbered and drops the trailing newline', () => {
    const lines = numberDiff(
      'abc\nauthor\n\nsubject\n\n a.py | 1 +\ndiff --git a/a.py b/a.py\n@@ -0,0 +1 @@\n+x\n',
    )
    expect(lines.map((l) => l.cls)).toEqual([
      'head',
      'head',
      'head',
      'head',
      'head',
      'head',
      'file',
      'hunk',
      'add',
    ])
    expect(lines.at(-1)).toEqual({ cls: 'add', new: 1, text: '+x' })
  })
  it('does not mistake a deleted line starting with --- for a header inside a hunk', () => {
    // A hunk line "--- x" is ambiguous in unified diffs; git itself emits "-" + "-- x".
    const lines = numberDiff('@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file')
    expect(lines.map((l) => l.cls)).toEqual(['hunk', 'del', 'add', 'meta'])
  })
})

describe('feedTotals', () => {
  it('counts a revert as deletions and ignores head moves', () => {
    const rows = [
      { type: 'edit', dAdded: 5, dDeleted: 1 },
      { type: 'edit', dAdded: -3, dDeleted: 0 },
      { type: 'commit' },
      { type: 'head' },
    ]
    expect(feedTotals(rows)).toEqual({ added: 5, deleted: 4, edits: 2, commits: 1 })
  })
})
