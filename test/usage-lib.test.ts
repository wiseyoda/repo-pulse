import { describe, expect, it } from 'vitest'
import {
  bucketUsage,
  DEFAULT_ITEM_PATTERN,
  fmtUsd,
  groupUsage,
  itemForUsage,
  usageSessions,
  usageTotals,
  type UsageLike,
} from '../public/lib.js'

const e = (over: Partial<UsageLike>): UsageLike => ({
  ts: 1000,
  tool: 'claude',
  seat: 'claude',
  session: 's1',
  model: 'm',
  branch: null,
  input: 10,
  output: 5,
  cacheWrite: 20,
  cacheRead: 70,
  usd: 0.5,
  ...over,
})

describe('usageTotals / groupUsage', () => {
  it('sums token classes, cost, cache hit ratio, and counts unpriced entries', () => {
    const t = usageTotals([e({}), e({ usd: null, session: 's2' })])
    expect(t).toMatchObject({ usd: 0.5, tokens: 210, n: 2, unpriced: 1, sessions: 2 })
    expect(t.cacheHit).toBeCloseTo(140 / 200)
  })
  it('groups by a key and sorts by cost', () => {
    const g = groupUsage(
      [e({ model: 'a', usd: 1 }), e({ model: 'b', usd: 3 }), e({ model: 'a', usd: 1 })],
      (x) => x.model,
    )
    expect(g.map((r) => [r.key, r.usd, r.n])).toEqual([
      ['b', 3, 1],
      ['a', 2, 2],
    ])
  })
})

describe('bucketUsage', () => {
  it('splits per bucket by series and covers the window', () => {
    const since = 60_000 * 10
    const out = bucketUsage(
      [
        e({ ts: since + 1000, tool: 'claude', usd: 1 }),
        e({ ts: since + 61_000, tool: 'codex', usd: 2 }),
        e({ ts: since + 61_500, tool: 'claude', usd: 4 }),
      ],
      since,
      since + 3 * 60_000 - 1,
      60_000,
      (x) => x.tool,
      (x) => x.usd ?? 0,
    )
    expect(out).toHaveLength(3)
    expect(out[0]?.values).toEqual({ claude: 1 })
    expect(out[1]?.values).toEqual({ codex: 2, claude: 4 })
    expect(out[2]?.values).toEqual({})
  })
})

describe('itemForUsage', () => {
  const commits = [
    { ts: 2000, subject: 'feat: a (W-010)' },
    { ts: 5000, subject: 'fix: b (W-012)' },
  ]
  it('reads the id from the branch first', () => {
    expect(itemForUsage(e({ branch: 'feature/W-099-thing' }), commits, DEFAULT_ITEM_PATTERN)).toBe(
      'W-099',
    )
  })
  it('falls back to the next commit within the horizon', () => {
    expect(itemForUsage(e({ ts: 1500 }), commits, DEFAULT_ITEM_PATTERN)).toBe('W-010')
    expect(itemForUsage(e({ ts: 2500 }), commits, DEFAULT_ITEM_PATTERN)).toBe('W-012')
    expect(itemForUsage(e({ ts: 6000 }), commits, DEFAULT_ITEM_PATTERN)).toBeNull()
    expect(itemForUsage(e({ ts: 1500 }), commits, DEFAULT_ITEM_PATTERN, 100)).toBeNull()
  })
})

describe('usageSessions / fmtUsd', () => {
  it('rolls entries into sessions newest first with their span and models', () => {
    const s = usageSessions([
      e({ ts: 1, model: 'a' }),
      e({ ts: 9, model: 'b', branch: 'main' }),
      e({ ts: 5, session: 's2' }),
    ])
    expect(s.map((r) => r.session)).toEqual(['s1', 's2'])
    expect(s[0]).toMatchObject({
      first: 1,
      last: 9,
      models: ['a', 'b'],
      branch: 'main',
      n: 2,
      usd: 1,
    })
  })
  it('formats dollars at a sensible precision', () => {
    expect(fmtUsd(0)).toBe('$0')
    expect(fmtUsd(0.004)).toBe('<$0.01')
    expect(fmtUsd(0.42)).toBe('$0.42')
    expect(fmtUsd(12.345)).toBe('$12.3')
    expect(fmtUsd(181.4)).toBe('$181')
    expect(fmtUsd(1234)).toBe('$1.2K')
  })
})
