import { describe, expect, it } from 'vitest'
import {
  fleetCoverageSummary,
  fleetDays,
  fleetGroup,
  fleetIdentityNotes,
  fleetTotals,
} from '../public/lib.js'
import type { FleetCoverageHost, FleetUsageRow } from '../src/fleet-usage.ts'

function row(over: Partial<FleetUsageRow> = {}): FleetUsageRow {
  const counts = { input: 10, output: 5, cacheWrite: 3, cacheRead: 2, total: 20 }
  return {
    date: '2026-09-20',
    hostId: 'mini-work',
    sourceId: 'claude',
    repositoryId: 'repo:ai-mux-suite',
    projectIdentityBasis: 'configured-root',
    repositoryIdentityConfidence: 'high',
    model: 'claude-sonnet-4-5',
    role: 'main',
    aggregateBasis: 'project_daily2-exact',
    temporalAllocationBasis: 'usage-date-per-request',
    temporalAllocationConfidence: 'high',
    counts,
    valuation: {
      usageDateApiEquivalentUsd: 1,
      usageDatePriceBasis: 'effective-dated-rate',
      currentPriceApiEquivalentUsd: 1,
      currentPriceDate: '2026-09-21',
      currentPriceBasis: 'effective-dated-rate',
      configuredSubscriptionCostUsd: null,
      actualBilledCashUsd: null,
    },
    ...over,
  }
}

const unpriced = (over: Partial<FleetUsageRow> = {}): FleetUsageRow =>
  row({
    ...over,
    valuation: {
      ...row().valuation,
      usageDateApiEquivalentUsd: null,
      usageDatePriceBasis: 'unpriced-model',
      currentPriceApiEquivalentUsd: null,
    },
  })

const host = (over: Partial<FleetCoverageHost> = {}): FleetCoverageHost => ({
  hostId: 'mini-work',
  requestedStart: '2026-09-14',
  requestedEnd: '2026-09-21',
  lastSuccessfulCollectionAt: '2026-09-21T15:00:00Z',
  lastAttemptAt: '2026-09-21T15:00:00Z',
  lastFullCollectionAt: null,
  latestCollectionFailed: false,
  observedUsageStart: '2026-09-20',
  observedUsageEnd: '2026-09-20',
  state: 'aggregate-observed',
  incompleteReasons: [],
  temporalCompletenessClaimed: false,
  ...over,
})

const interval = {
  startDateInclusive: '2026-09-18',
  endDateInclusive: '2026-09-21',
  timezone: 'America/New_York',
  dateSemantics: 'ledger-local-calendar-date',
}

describe('fleetTotals', () => {
  it('adds fleet rows only and keeps an unknown value unknown', () => {
    const totals = fleetTotals([row(), row({ hostId: 'mbp-work' }), unpriced({ model: 'mystery' })])
    expect(totals.tokens).toBe(60)
    expect(totals.rows).toBe(3)
    expect(totals.usd).toBeNull()
    expect(totals.pricedUsd).toBe(2)
    expect(totals.unpricedRows).toBe(1)
    expect(totals.hosts).toEqual(['mbp-work', 'mini-work'])
    expect(totals.models).toEqual(['claude-sonnet-4-5', 'mystery'])
    expect(totals.days).toEqual(['2026-09-20'])
  })

  it('reports a known total when every row is priced', () => {
    const totals = fleetTotals([row(), row()])
    expect(totals.usd).toBe(2)
    expect(totals.unpricedRows).toBe(0)
    expect(totals.cacheHit).toBeCloseTo(2 / 15)
  })

  it('never treats subscription price or billed cash as the value', () => {
    const subscribed = row({
      valuation: {
        ...row().valuation,
        configuredSubscriptionCostUsd: 200,
        actualBilledCashUsd: null,
      },
    })
    const totals = fleetTotals([subscribed])
    expect(totals.usd).toBe(1)
    expect(totals.subscriptionRows).toBe(1)
    expect(totals.billedRows).toBe(0)
    expect(Object.values(totals)).not.toContain(200)
  })

  it('keeps duplicate-looking rows as separate aggregates instead of collapsing them', () => {
    // No shared event IDs exist, so two bases for the same host/date/model are two rows.
    const exact = row()
    const fallback = row({
      aggregateBasis: 'session-last-activity',
      temporalAllocationConfidence: 'low',
    })
    const totals = fleetTotals([exact, fallback])
    expect(totals.rows).toBe(2)
    expect(totals.tokens).toBe(40)
    expect(fleetGroup([exact, fallback], (r) => r.aggregateBasis).map((g) => g.key)).toEqual([
      'project_daily2-exact',
      'session-last-activity',
    ])
  })
})

describe('fleetGroup', () => {
  it('groups by any dimension and marks partially priced groups unknown', () => {
    const groups = fleetGroup(
      [row(), row({ hostId: 'mbp-work' }), unpriced({ hostId: 'mbp-work' })],
      (r) => r.hostId,
    )
    expect(groups.map((g) => g.key)).toEqual(['mbp-work', 'mini-work'])
    const mbp = groups[0]!
    const mini = groups[1]!
    expect(mbp.rows).toBe(2)
    expect(mbp.usd).toBeNull()
    expect(mbp.pricedUsd).toBe(1)
    expect(mini.usd).toBe(1)
  })
})

describe('fleetDays', () => {
  it('uses whole calendar days from the export interval, including empty days', () => {
    const days = fleetDays([row({ date: '2026-09-19' }), row({ date: '2026-09-21' })], interval)
    expect(days.map((d) => d.date)).toEqual([
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
    ])
    expect(days.map((d) => d.tokens)).toEqual([0, 20, 0, 20])
  })

  it('never reshapes fleet days into the page window and tolerates a missing interval', () => {
    const rows = [row({ date: '2026-09-19' }), row({ date: '2026-09-19' })]
    expect(fleetDays(rows, null)).toEqual([
      { date: '2026-09-19', tokens: 40, usd: 2, unpricedRows: 0 },
    ])
    const broken = fleetDays(rows, { ...interval, startDateInclusive: 'nonsense' })
    expect(broken.map((d) => d.date)).toEqual(['2026-09-19'])
  })

  it('marks a day unknown when one of its rows is unpriced', () => {
    const days = fleetDays([row(), unpriced()], interval)
    const day = days.find((d) => d.date === '2026-09-20')
    expect(day).toMatchObject({ tokens: 40, unpricedRows: 1 })
  })
})

describe('fleetCoverageSummary', () => {
  it('summarises host freshness against the export as-of time', () => {
    const summary = fleetCoverageSummary(
      [
        host(),
        host({
          hostId: 'mbp-work',
          lastSuccessfulCollectionAt: '2026-09-18T09:00:00Z',
          state: 'incomplete',
          incompleteReasons: ['last-successful-collection-before-interval-end'],
          observedUsageEnd: '2026-09-18',
        }),
        host({
          hostId: 'studio',
          lastSuccessfulCollectionAt: null,
          latestCollectionFailed: true,
          state: 'incomplete',
          incompleteReasons: ['latest-collection-error', 'no-successful-collection-recorded'],
          observedUsageEnd: null,
        }),
      ],
      '2026-09-21T16:00:00Z',
    )
    expect(summary.total).toBe(3)
    expect(summary.incomplete).toBe(2)
    expect(summary.failed).toBe(1)
    expect(summary.neverCollected).toBe(1)
    expect(summary.complete).toBe(false)
    expect(summary.hosts.map((h) => h.hostId)).toEqual(['mbp-work', 'mini-work', 'studio'])
    const stale = summary.hosts[0]!
    expect(stale.behindMs).toBe(3 * 86_400_000 + 7 * 3_600_000)
    expect(summary.hosts[2]!.behindMs).toBeNull()
    // Equal host counts fall back to alphabetical order, so the list is stable.
    expect(summary.reasons).toEqual([
      { reason: 'last-successful-collection-before-interval-end', hosts: 1 },
      { reason: 'latest-collection-error', hosts: 1 },
      { reason: 'no-successful-collection-recorded', hosts: 1 },
    ])
  })

  it('reports complete coverage only when every host was observed', () => {
    expect(fleetCoverageSummary([host()], '2026-09-21T16:00:00Z').complete).toBe(true)
    expect(fleetCoverageSummary([], '2026-09-21T16:00:00Z').complete).toBe(false)
  })
})

describe('fleetIdentityNotes', () => {
  it('separates repository identity confidence from time allocation confidence', () => {
    const notes = fleetIdentityNotes([
      row(),
      row({ repositoryIdentityConfidence: 'medium', projectIdentityBasis: 'host-local-full-path' }),
      row({
        repositoryIdentityConfidence: 'low',
        projectIdentityBasis: 'legacy-label-only',
        aggregateBasis: 'session-last-activity',
        temporalAllocationConfidence: 'low',
      }),
    ])
    expect(notes.weakestIdentity).toBe('low')
    expect(notes.weakestTemporal).toBe('low')
    expect(notes.identityConfidence.map((x) => x.key).sort()).toEqual(['high', 'low', 'medium'])
    expect(notes.temporalConfidence.find((x) => x.key === 'high')?.rows).toBe(2)
    expect(notes.aggregateBases.map((x) => x.key)).toEqual([
      'project_daily2-exact',
      'session-last-activity',
    ])
  })

  it('has no confidence claim without rows', () => {
    expect(fleetIdentityNotes([])).toMatchObject({
      weakestIdentity: null,
      weakestTemporal: null,
      identityConfidence: [],
    })
  })
})
