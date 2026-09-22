import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FLEET_SCHEMA_VERSION,
  FleetUsageTracker,
  parseFleetConfig,
  parseFleetSlice,
  safeExternalUrl,
  selectRepository,
  type FleetConfig,
  type FleetSlice,
  type FleetUsageRow,
} from '../src/fleet-usage.ts'

const fixtureNow = new Date().toISOString()

function row(over: Partial<FleetUsageRow> = {}): FleetUsageRow {
  const counts = { input: 10, output: 2, cacheWrite: 3, cacheRead: 5, total: 20 }
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
      usageDateApiEquivalentUsd: 0.25,
      usageDatePriceBasis: 'effective-dated-rate',
      currentPriceApiEquivalentUsd: 0.25,
      currentPriceDate: '2026-09-21',
      currentPriceBasis: 'effective-dated-rate',
      configuredSubscriptionCostUsd: null,
      actualBilledCashUsd: null,
    },
    ...over,
  }
}

function slice(over: Partial<FleetSlice> = {}): FleetSlice {
  return {
    schemaVersion: FLEET_SCHEMA_VERSION,
    generatedAt: fixtureNow,
    asOf: fixtureNow,
    requestedInterval: {
      startDateInclusive: '2026-09-14',
      endDateInclusive: '2026-09-21',
      timezone: 'America/New_York',
      dateSemantics: 'ledger-local-calendar-date',
    },
    eventLineage: { eventIdsAvailable: false, prospectiveCutoverAt: null, status: 'pending' },
    aggregateAuthority: {
      authoritative: true,
      authority: 'fleet-ledger-aggregates',
      relationshipToFleetTotals: 'repository slice; do not add to fleet totals',
    },
    usage: [row()],
    coverage: [
      {
        hostId: 'mini-work',
        requestedStart: '2026-09-14',
        requestedEnd: '2026-09-21',
        lastSuccessfulCollectionAt: '2026-09-21T15:00:00+00:00',
        lastAttemptAt: '2026-09-21T15:00:00+00:00',
        lastFullCollectionAt: null,
        latestCollectionFailed: false,
        observedUsageStart: '2026-09-20',
        observedUsageEnd: '2026-09-20',
        state: 'aggregate-observed',
        incompleteReasons: [],
        temporalCompletenessClaimed: false,
      },
    ],
    issues: [],
    ...over,
  }
}

/** The producer emits fields this consumer does not use; they must not cross the boundary. */
function producerPayload(): Record<string, unknown> {
  return {
    ...slice(),
    valuationProvenance: { usageDateApiEquivalentUsd: 'effective-dated pricing table' },
    observations: {
      schemaVersion: 'accounts.observations.v1',
      observations: [{ accountId: 'account_secret', profileId: 'profile_secret' }],
    },
  }
}

const config = (over: Partial<FleetConfig> = {}): FleetConfig => ({
  source: { kind: 'file', label: '/tmp/repository-usage.json', path: '/tmp/repository-usage.json' },
  repositoryId: 'repo:ai-mux-suite',
  hostIds: [],
  fleetHistoryUrl: null,
  ...over,
})

async function workspace(): Promise<{ dir: string; state: string; exportPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'repo-pulse-fleet-'))
  return {
    dir,
    state: path.join(dir, 'state'),
    exportPath: path.join(dir, 'repository-usage.json'),
  }
}

async function configured(dir: string, body: Record<string, unknown>): Promise<string> {
  const file = path.join(dir, 'fleet-usage.json')
  await writeFile(file, JSON.stringify(body))
  return file
}

describe('accounts.repository-usage.v1 validation', () => {
  it('accepts the producer payload and projects only the fields the page uses', () => {
    const parsed = parseFleetSlice(JSON.stringify(producerPayload()))
    expect(parsed).toEqual(slice())
    expect(JSON.stringify(parsed)).not.toContain('account_secret')
    expect(JSON.stringify(parsed)).not.toContain('valuationProvenance')
  })

  it('rejects a wrong schema version, interval or lineage', () => {
    expect(() => parseFleetSlice('nope')).toThrow('not valid JSON')
    expect(() =>
      parseFleetSlice(
        JSON.stringify({ ...slice(), schemaVersion: 'accounts.repository-usage.v2' }),
      ),
    ).toThrow('unsupported fleet export schema')
    expect(() =>
      parseFleetSlice(
        JSON.stringify({
          ...slice(),
          requestedInterval: { ...slice().requestedInterval, endDateInclusive: '2026-09-01' },
        }),
      ),
    ).toThrow('invalid requestedInterval')
    expect(() =>
      parseFleetSlice(
        JSON.stringify({
          ...slice(),
          eventLineage: { eventIdsAvailable: 'no', status: 'pending' },
        }),
      ),
    ).toThrow('invalid eventLineage')
    expect(() => parseFleetSlice(JSON.stringify({ ...slice(), asOf: 'whenever' }))).toThrow(
      'generatedAt/asOf',
    )
  })

  it('rejects non-finite, negative and inconsistent counters', () => {
    for (const counts of [
      { input: -1, output: 2, cacheWrite: 3, cacheRead: 5, total: 9 },
      { input: 10, output: 2, cacheWrite: 3, cacheRead: 5, total: 21 },
      { input: 'ten', output: 2, cacheWrite: 3, cacheRead: 5, total: 20 },
      { input: 10, output: 2, cacheWrite: 3, cacheRead: 5 },
    ]) {
      expect(() =>
        parseFleetSlice(JSON.stringify({ ...slice(), usage: [{ ...row(), counts }] })),
      ).toThrow('invalid usage row')
    }
    // JSON cannot carry Infinity, so a string sentinel is the reachable case.
    expect(() =>
      parseFleetSlice(
        JSON.stringify({
          ...slice(),
          usage: [{ ...row(), counts: { ...row().counts, total: null } }],
        }),
      ),
    ).toThrow('invalid usage row')
  })

  it('keeps valuation nullable but rejects malformed money, dates and confidence', () => {
    const unknown = row({
      valuation: {
        ...row().valuation,
        usageDateApiEquivalentUsd: null,
        currentPriceApiEquivalentUsd: null,
      },
    })
    expect(
      parseFleetSlice(JSON.stringify({ ...slice(), usage: [unknown] })).usage[0]!.valuation,
    ).toMatchObject({ usageDateApiEquivalentUsd: null, currentPriceApiEquivalentUsd: null })
    for (const valuation of [
      { ...row().valuation, usageDateApiEquivalentUsd: -1 },
      { ...row().valuation, usageDateApiEquivalentUsd: 'free' },
      { ...row().valuation, currentPriceDate: '2026-02-30' },
      { ...row().valuation, usageDatePriceBasis: '' },
    ]) {
      expect(() =>
        parseFleetSlice(JSON.stringify({ ...slice(), usage: [{ ...row(), valuation }] })),
      ).toThrow('invalid usage row')
    }
    expect(() =>
      parseFleetSlice(
        JSON.stringify({ ...slice(), usage: [row({ repositoryIdentityConfidence: 'certain' })] }),
      ),
    ).toThrow('invalid usage row')
    expect(() =>
      parseFleetSlice(
        JSON.stringify({ ...slice(), usage: [row({ temporalAllocationConfidence: 'guess' })] }),
      ),
    ).toThrow('invalid usage row')
    expect(() =>
      parseFleetSlice(JSON.stringify({ ...slice(), usage: [row({ date: '20-09-2026' })] })),
    ).toThrow('invalid usage row')
  })

  it('rejects malformed coverage and issues', () => {
    const coverage = slice().coverage[0]!
    expect(() =>
      parseFleetSlice(JSON.stringify({ ...slice(), coverage: [{ ...coverage, state: 'fine' }] })),
    ).toThrow('invalid coverage entry')
    expect(() =>
      parseFleetSlice(
        JSON.stringify({ ...slice(), coverage: [{ ...coverage, latestCollectionFailed: 'no' }] }),
      ),
    ).toThrow('invalid coverage entry')
    expect(() =>
      parseFleetSlice(
        JSON.stringify({ ...slice(), coverage: [{ ...coverage, incompleteReasons: [{}] }] }),
      ),
    ).toThrow('invalid coverage entry')
    expect(() =>
      parseFleetSlice(JSON.stringify({ ...slice(), issues: [{ detail: 'x' }] })),
    ).toThrow('invalid issue')
    const withIssue = parseFleetSlice(
      JSON.stringify({ ...slice(), issues: [{ code: 'session-basis', detail: 'spans end' }] }),
    )
    expect(withIssue.issues).toEqual([{ code: 'session-basis', detail: 'spans end' }])
  })
})

describe('repository matching', () => {
  it('never forwards fleet-wide issue details into a repository-scoped response', () => {
    const result = selectRepository(
      slice({ issues: [{ code: 'metadata_issue', detail: 'other repository /private/project' }] }),
      config(),
    )
    expect(result.issues).toEqual([{ code: 'metadata_issue', detail: null }])
    expect(JSON.stringify(result)).not.toContain('/private/project')
  })
  it('matches only the configured repository ID and never infers one', () => {
    const payload = slice({
      usage: [
        row(),
        row({ repositoryId: 'repo:other-project', hostId: 'mbp-work' }),
        row({ repositoryId: 'host-path:mini-work:deadbeef', sourceId: 'codex' }),
        row({ repositoryId: 'legacy:mini-work:abc123', sourceId: 'grok' }),
      ],
    })
    const selection = selectRepository(payload, config())
    expect(selection.rows).toHaveLength(1)
    expect(selection.rows[0]!.repositoryId).toBe('repo:ai-mux-suite')
    expect(selection.unmatched).toEqual({ rows: 3, repositories: 3, hostsOutsideScope: 0 })
    // Unmatched repositories are counted, never named or attributed to this repo.
    expect(JSON.stringify(selection)).not.toContain('repo:other-project')
    expect(JSON.stringify(selection)).not.toContain('legacy:mini-work')

    // A basename, remote name or worktree directory name is not an identity.
    for (const wrong of ['ai-mux-suite', 'repo-pulse', '.worktrees/feature']) {
      expect(selectRepository(payload, config({ repositoryId: wrong })).rows).toEqual([])
    }
  })

  it('applies explicit host scoping to rows and coverage', () => {
    const payload = slice({
      usage: [row(), row({ hostId: 'mbp-work' })],
      coverage: [
        slice().coverage[0]!,
        { ...slice().coverage[0]!, hostId: 'mbp-work' },
        { ...slice().coverage[0]!, hostId: 'studio' },
      ],
    })
    const scoped = selectRepository(payload, config({ hostIds: ['mini-work'] }))
    expect(scoped.rows.map((r) => r.hostId)).toEqual(['mini-work'])
    expect(scoped.coverage.map((c) => c.hostId)).toEqual(['mini-work'])
    expect(scoped.unmatched.hostsOutsideScope).toBe(1)
    const all = selectRepository(payload, config())
    expect(all.rows).toHaveLength(2)
    expect(all.coverage).toHaveLength(3)
  })

  it('reports no rows rather than a guess when the ID is absent from the export', () => {
    const selection = selectRepository(slice({ usage: [] }), config())
    expect(selection.rows).toEqual([])
    expect(selection.unmatched.rows).toBe(0)
    expect(selection.requestedInterval.timezone).toBe('America/New_York')
  })

  it('keeps duplicate-looking rows separate instead of deduplicating or summing', () => {
    // Same repository, host, date and model on two bases: no event IDs exist, so the
    // consumer must present both rows as the producer emitted them.
    const payload = slice({
      usage: [
        row(),
        row({ aggregateBasis: 'session-last-activity', temporalAllocationConfidence: 'low' }),
      ],
    })
    const selection = selectRepository(payload, config())
    expect(selection.rows).toHaveLength(2)
    expect(selection.eventLineage.eventIdsAvailable).toBe(false)
    expect(selection.aggregateAuthority.relationshipToFleetTotals).toContain('do not add')
  })
})

describe('fleet configuration', () => {
  it('requires exactly one source and an explicit repository ID', () => {
    expect(() => parseFleetConfig('{')).toThrow('not valid JSON')
    expect(() => parseFleetConfig(JSON.stringify({ repositoryId: 'repo:x' }))).toThrow(
      'source with a path or url',
    )
    expect(() =>
      parseFleetConfig(
        JSON.stringify({ source: { path: '/a.json', url: 'https://h/a.json' }, repositoryId: 'r' }),
      ),
    ).toThrow('exactly one of path or url')
    expect(() => parseFleetConfig(JSON.stringify({ source: { path: '/a.json' } }))).toThrow(
      'repositoryId',
    )
    expect(() =>
      parseFleetConfig(JSON.stringify({ source: { path: 'relative.json' }, repositoryId: 'r' })),
    ).toThrow('absolute path')
  })

  it('refuses non-http(s) schemes, URL userinfo and unsafe history links', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://host/a.json',
      'http://user:secret@host/a.json',
      'https://token@host/a.json',
      'https://host/a.json?token=secret',
      ' https://host/a.json',
      'https://host/a.json\n',
    ]) {
      expect(() =>
        parseFleetConfig(JSON.stringify({ source: { url }, repositoryId: 'r' })),
      ).toThrow('without embedded credentials')
      expect(safeExternalUrl(url)).toBeNull()
    }
    expect(() =>
      parseFleetConfig(
        JSON.stringify({
          source: { url: 'http://100.71.1.121:8787/repository-usage.json' },
          repositoryId: 'r',
          fleetHistoryUrl: 'javascript:alert(1)',
        }),
      ),
    ).toThrow('fleetHistoryUrl')
  })

  it('omits fragments from the reported source label', () => {
    const parsed = parseFleetConfig(
      JSON.stringify({
        source: { url: 'http://100.71.1.121:8787/repository-usage.json#x' },
        repositoryId: 'repo:ai-mux-suite',
        hostIds: ['mini-work', 'mini-work'],
        fleetHistoryUrl: 'http://100.71.1.121:8787/',
      }),
    )
    expect(parsed.source.label).toBe('http://100.71.1.121:8787/repository-usage.json')
    expect(parsed.source.url).toContain('#x')
    expect(parsed.hostIds).toEqual(['mini-work'])
    expect(parsed.fleetHistoryUrl).toBe('http://100.71.1.121:8787/')
  })
})

describe('FleetUsageTracker', () => {
  it('refresh rereads new configuration and never relabels another source cache', async () => {
    const { dir, state, exportPath } = await workspace()
    const configPath = path.join(dir, 'config.json')
    const tracker = new FleetUsageTracker(state, { configPath })
    expect((await tracker.get()).configured).toBe(false)
    await writeFile(exportPath, JSON.stringify(slice()))
    await writeFile(
      configPath,
      JSON.stringify({ source: { path: exportPath }, repositoryId: 'repo:ai-mux-suite' }),
    )
    expect((await tracker.get(true)).selection?.rows).toHaveLength(1)
    await writeFile(
      configPath,
      JSON.stringify({
        source: { path: path.join(dir, 'new-missing.json') },
        repositoryId: 'repo:ai-mux-suite',
      }),
    )
    const changed = await tracker.get(true)
    expect(changed.state).toBe('unavailable')
    expect(changed.selection).toBeNull()
  })

  it('recent fetching cannot make an old or future-dated export fresh', async () => {
    const { dir, state, exportPath } = await workspace()
    const configPath = await configured(dir, {
      source: { path: exportPath },
      repositoryId: 'repo:ai-mux-suite',
    })
    for (const offset of [-7 * 3_600_000, 60_000]) {
      const at = new Date(Date.now() + offset).toISOString()
      await writeFile(exportPath, JSON.stringify(slice({ generatedAt: at, asOf: at })))
      const tracker = new FleetUsageTracker(state, { configPath })
      expect((await tracker.get(true)).state).toBe('stale')
    }
  })

  it('bounds local files and reports source failures without leaking filesystem paths', async () => {
    const { dir, state, exportPath } = await workspace()
    await writeFile(exportPath, JSON.stringify(slice()))
    const configPath = await configured(dir, {
      source: { path: exportPath },
      repositoryId: 'repo:ai-mux-suite',
    })
    const large = await new FleetUsageTracker(state, { configPath, maxBytes: 32 }).get()
    expect(large.error).toContain('size limit')
    await writeFile(
      configPath,
      JSON.stringify({ source: { path: dir }, repositoryId: 'repo:ai-mux-suite' }),
    )
    const directory = await new FleetUsageTracker(state, { configPath }).get()
    expect(directory.error).toContain('regular file')
    expect(directory.error).not.toContain(dir)
  })

  it('does nothing at all without a config file', async () => {
    const { dir, state } = await workspace()
    let calls = 0
    const tracker = new FleetUsageTracker(state, {
      configPath: path.join(dir, 'absent.json'),
      fetchImpl: (async () => {
        calls++
        throw new Error('should not be called')
      }) as unknown as typeof fetch,
    })
    const status = await tracker.get(true)
    expect(status).toMatchObject({ configured: false, state: 'unconfigured', selection: null })
    expect(calls).toBe(0)
    await expect(readdir(state)).rejects.toThrow()
  })

  it('reads a local export, scopes it to the repository, and caches outside the repo', async () => {
    const { dir, state, exportPath } = await workspace()
    await writeFile(
      exportPath,
      JSON.stringify(slice({ usage: [row(), row({ repositoryId: 'repo:other' })] })),
    )
    const configPath = await configured(dir, {
      source: { path: exportPath },
      repositoryId: 'repo:ai-mux-suite',
    })
    const tracker = new FleetUsageTracker(state, { configPath })
    const status = await tracker.get()
    expect(status.state).toBe('available')
    expect(status.selection?.rows).toHaveLength(1)
    expect(status.selection?.unmatched.rows).toBe(1)
    expect(status.sourceKind).toBe('file')

    const cached = (await readdir(state)).filter((name) => name.startsWith('fleet-usage-'))
    expect(cached).toHaveLength(1)
    const record = JSON.parse(await readFile(path.join(state, cached[0]!), 'utf8'))
    expect(record.slice.usage).toHaveLength(2)

    // A second tracker serves the cache without touching the source again.
    await writeFile(exportPath, 'corrupted')
    const warm = await new FleetUsageTracker(state, { configPath }).get()
    expect(warm.state).toBe('available')
    expect(warm.fromCache).toBe(true)
    expect(warm.selection?.rows).toHaveLength(1)
  })

  it('serves the last good slice and an explicit error when the source breaks', async () => {
    const { dir, state, exportPath } = await workspace()
    await writeFile(exportPath, JSON.stringify(slice()))
    const configPath = await configured(dir, {
      source: { path: exportPath },
      repositoryId: 'repo:ai-mux-suite',
    })
    const tracker = new FleetUsageTracker(state, { configPath })
    await tracker.get()
    await writeFile(exportPath, '{"schemaVersion":"accounts.repository-usage.v9"}')
    const broken = await tracker.get(true)
    expect(broken.state).toBe('stale')
    expect(broken.stale).toBe(true)
    expect(broken.error).toContain('unsupported fleet export schema')
    expect(broken.selection?.rows).toHaveLength(1)

    const missing = new FleetUsageTracker(state, {
      configPath: await configured(dir, {
        source: { path: path.join(dir, 'gone.json') },
        repositoryId: 'repo:ai-mux-suite',
      }),
    })
    const unavailable = await missing.get(true)
    expect(unavailable.state).toBe('unavailable')
    expect(unavailable.error).toContain('missing')
    expect(unavailable.selection).toBeNull()
  })

  it('reports a config error without reading anything', async () => {
    const { dir, state } = await workspace()
    const configPath = await configured(dir, {
      source: { url: 'ftp://host/x.json' },
      repositoryId: 'r',
    })
    const status = await new FleetUsageTracker(state, { configPath }).get(true)
    expect(status.configured).toBe(false)
    expect(status.state).toBe('unconfigured')
    expect(status.configError).toContain('http(s)')
  })

  it('marks a slice stale once it is older than the freshness budget', async () => {
    const { dir, state, exportPath } = await workspace()
    await writeFile(exportPath, JSON.stringify(slice()))
    const configPath = await configured(dir, {
      source: { path: exportPath },
      repositoryId: 'repo:ai-mux-suite',
    })
    let clock = Date.now()
    const tracker = new FleetUsageTracker(state, {
      configPath,
      staleAfterMs: 1000,
      now: () => clock,
    })
    expect((await tracker.get()).state).toBe('available')
    clock += 5000
    const later = tracker.status()
    expect(later.state).toBe('stale')
    expect(later.stale).toBe(true)
    expect(later.selection?.rows).toHaveLength(1)
  })

  it('bounds URL reads, hides upstream bodies, and coalesces concurrent refreshes', async () => {
    const { dir, state } = await workspace()
    const configPath = await configured(dir, {
      source: { url: 'http://127.0.0.1:9/repository-usage.json' },
      repositoryId: 'repo:ai-mux-suite',
    })
    let calls = 0
    const respond = (body: string, init: ResponseInit = {}): typeof fetch =>
      (async (_input: unknown, options: { redirect?: string } = {}) => {
        calls++
        expect(options.redirect).toBe('error')
        return new Response(body, init)
      }) as unknown as typeof fetch

    const ok = new FleetUsageTracker(state, {
      configPath,
      fetchImpl: respond(JSON.stringify(slice())),
    })
    const [a, b] = await Promise.all([ok.get(true), ok.get(true)])
    expect(calls).toBe(1)
    expect(a.selection?.rows).toEqual(b.selection?.rows)
    expect(a.state).toBe('available')

    const secret = 'upstream stack trace with /etc/shadow'
    const failing = new FleetUsageTracker(state, {
      configPath: await configured(dir, {
        source: { url: 'http://127.0.0.1:9/other.json' },
        repositoryId: 'repo:ai-mux-suite',
      }),
      fetchImpl: respond(secret, { status: 500 }),
    })
    const failed = await failing.get(true)
    expect(failed.error).toBe('the fleet export request failed with HTTP 500')
    expect(JSON.stringify(failed)).not.toContain('etc/shadow')

    const big = new FleetUsageTracker(state, {
      configPath: await configured(dir, {
        source: { url: 'http://127.0.0.1:9/big.json' },
        repositoryId: 'repo:ai-mux-suite',
      }),
      maxBytes: 32,
      fetchImpl: respond(JSON.stringify(slice())),
    })
    expect((await big.get(true)).error).toContain('exceeds the size limit')
  })

  it('times out a hanging source and never leaves the page without a state', async () => {
    const { dir, state } = await workspace()
    const configPath = await configured(dir, {
      source: { url: 'http://127.0.0.1:9/slow.json' },
      repositoryId: 'repo:ai-mux-suite',
    })
    const tracker = new FleetUsageTracker(state, {
      configPath,
      timeoutMs: 20,
      fetchImpl: ((_input: unknown, options: { signal?: AbortSignal } = {}) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })) as unknown as typeof fetch,
    })
    const status = await tracker.get(true)
    expect(status.state).toBe('unavailable')
    expect(status.error).toContain('timed out')
  })
})
