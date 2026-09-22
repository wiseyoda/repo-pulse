import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Optional read-only consumer of Usage's `accounts.repository-usage.v1` export.
 *
 * The export is authoritative fleet aggregates with no shared event IDs, so it is never
 * added to local transcript usage and never deduplicated against it. Nothing here runs
 * unless the owner wrote a config: no discovery, no polling, no request without a config.
 */

export const FLEET_SCHEMA_VERSION = 'accounts.repository-usage.v1'
export const CONFIG_FILE = 'fleet-usage.json'
const CACHE_VERSION = 1
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_STALE_AFTER_MS = 6 * 3_600_000
const MAX_ROWS = 50_000
const MAX_COVERAGE = 512
const MAX_ISSUES = 256
const MAX_ID = 512
const CONFIDENCES = ['high', 'medium', 'low']
const COVERAGE_STATES = ['aggregate-observed', 'incomplete']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface FleetCounts {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  total: number
}

export interface FleetValuation {
  usageDateApiEquivalentUsd: number | null
  usageDatePriceBasis: string
  currentPriceApiEquivalentUsd: number | null
  currentPriceDate: string | null
  currentPriceBasis: string
  configuredSubscriptionCostUsd: number | null
  actualBilledCashUsd: number | null
}

export interface FleetUsageRow {
  date: string
  hostId: string
  sourceId: string
  repositoryId: string
  projectIdentityBasis: string
  repositoryIdentityConfidence: string
  model: string
  role: string
  aggregateBasis: string
  temporalAllocationBasis: string
  temporalAllocationConfidence: string
  counts: FleetCounts
  valuation: FleetValuation
}

export interface FleetCoverageHost {
  hostId: string
  requestedStart: string
  requestedEnd: string
  lastSuccessfulCollectionAt: string | null
  lastAttemptAt: string | null
  lastFullCollectionAt: string | null
  latestCollectionFailed: boolean
  observedUsageStart: string | null
  observedUsageEnd: string | null
  state: string
  incompleteReasons: string[]
  temporalCompletenessClaimed: boolean
}

export interface FleetInterval {
  startDateInclusive: string
  endDateInclusive: string
  timezone: string
  dateSemantics: string
}

export interface FleetSlice {
  schemaVersion: string
  generatedAt: string
  asOf: string
  requestedInterval: FleetInterval
  eventLineage: { eventIdsAvailable: boolean; prospectiveCutoverAt: string | null; status: string }
  aggregateAuthority: {
    authoritative: boolean
    authority: string
    relationshipToFleetTotals: string
  }
  usage: FleetUsageRow[]
  coverage: FleetCoverageHost[]
  issues: { code: string; detail: string | null }[]
}

/** The repository-scoped projection the page is allowed to see. */
export interface FleetSelection {
  repositoryId: string
  hostIds: string[]
  asOf: string
  generatedAt: string
  requestedInterval: FleetInterval
  eventLineage: FleetSlice['eventLineage']
  aggregateAuthority: FleetSlice['aggregateAuthority']
  rows: FleetUsageRow[]
  coverage: FleetCoverageHost[]
  issues: { code: string; detail: string | null }[]
  /** Rows in the export that belong to other repositories, counted but never named or attributed. */
  unmatched: { rows: number; repositories: number; hostsOutsideScope: number }
}

export interface FleetSource {
  kind: 'file' | 'url'
  /** Absolute path, or the URL with userinfo, query and fragment removed. */
  label: string
  path?: string
  url?: string
}

export interface FleetConfig {
  source: FleetSource
  repositoryId: string
  hostIds: string[]
  fleetHistoryUrl: string | null
}

export interface FleetStatus {
  configured: boolean
  state: 'unconfigured' | 'available' | 'stale' | 'unavailable'
  configError: string | null
  error: string | null
  sourceKind: 'file' | 'url' | null
  sourceLabel: string | null
  repositoryId: string | null
  hostIds: string[]
  fleetHistoryUrl: string | null
  configPath: string
  fetchedAt: number | null
  stale: boolean
  fromCache: boolean
  staleAfterMs: number
  selection: FleetSelection | null
}

interface CacheRecord {
  version: number
  configFingerprint: string
  fetchedAt: number
  slice: FleetSlice
}

export interface FleetTrackerOptions {
  configPath?: string
  timeoutMs?: number
  maxBytes?: number
  staleAfterMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown, max = MAX_ID): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f\u007f]/.test(value)

const isCounter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const isMoney = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)

const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const parts = value.split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  const at = new Date(Date.UTC(year, month - 1, day))
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
}

const isStamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
    value,
  ) &&
  isDate(value.slice(0, 10)) &&
  Number.isFinite(Date.parse(value))

const isChoice = (value: unknown, choices: string[]): value is string =>
  typeof value === 'string' && choices.includes(value)

function counts(value: unknown): FleetCounts | null {
  if (!isObject(value)) return null
  const { input, output, cacheWrite, cacheRead, total } = value
  if (
    !isCounter(input) ||
    !isCounter(output) ||
    !isCounter(cacheWrite) ||
    !isCounter(cacheRead) ||
    !isCounter(total)
  ) {
    return null
  }
  // The producer defines total as the sum of the four classes; a mismatch is a broken payload.
  const sum = input + output + cacheWrite + cacheRead
  if (total !== sum) return null
  return { input, output, cacheWrite, cacheRead, total: sum }
}

function valuation(value: unknown): FleetValuation | null {
  if (!isObject(value)) return null
  const currentPriceDate = value.currentPriceDate
  if (
    !isMoney(value.usageDateApiEquivalentUsd) ||
    !isMoney(value.currentPriceApiEquivalentUsd) ||
    !isMoney(value.configuredSubscriptionCostUsd) ||
    !isMoney(value.actualBilledCashUsd) ||
    !isText(value.usageDatePriceBasis, 64) ||
    !isText(value.currentPriceBasis, 64) ||
    !(currentPriceDate === null || isDate(currentPriceDate))
  ) {
    return null
  }
  return {
    usageDateApiEquivalentUsd: value.usageDateApiEquivalentUsd,
    usageDatePriceBasis: value.usageDatePriceBasis,
    currentPriceApiEquivalentUsd: value.currentPriceApiEquivalentUsd,
    currentPriceDate: currentPriceDate as string | null,
    currentPriceBasis: value.currentPriceBasis,
    configuredSubscriptionCostUsd: value.configuredSubscriptionCostUsd,
    actualBilledCashUsd: value.actualBilledCashUsd,
  }
}

function usageRow(value: unknown): FleetUsageRow | null {
  if (!isObject(value)) return null
  const c = counts(value.counts)
  const v = valuation(value.valuation)
  if (
    !c ||
    !v ||
    !isDate(value.date) ||
    !isText(value.hostId) ||
    !isText(value.sourceId) ||
    !isText(value.repositoryId) ||
    !isText(value.projectIdentityBasis, 64) ||
    !isChoice(value.repositoryIdentityConfidence, CONFIDENCES) ||
    !isText(value.model, 128) ||
    !isText(value.role, 64) ||
    !isText(value.aggregateBasis, 64) ||
    !isText(value.temporalAllocationBasis, 64) ||
    !isChoice(value.temporalAllocationConfidence, CONFIDENCES)
  ) {
    return null
  }
  return {
    date: value.date,
    hostId: value.hostId,
    sourceId: value.sourceId,
    repositoryId: value.repositoryId,
    projectIdentityBasis: value.projectIdentityBasis,
    repositoryIdentityConfidence: value.repositoryIdentityConfidence,
    model: value.model,
    role: value.role,
    aggregateBasis: value.aggregateBasis,
    temporalAllocationBasis: value.temporalAllocationBasis,
    temporalAllocationConfidence: value.temporalAllocationConfidence,
    counts: c,
    valuation: v,
  }
}

function coverageHost(value: unknown): FleetCoverageHost | null {
  if (!isObject(value)) return null
  const nullableStamp = (input: unknown): boolean => input === null || isStamp(input)
  const nullableDate = (input: unknown): boolean => input === null || isDate(input)
  if (
    !isText(value.hostId) ||
    !isDate(value.requestedStart) ||
    !isDate(value.requestedEnd) ||
    !nullableStamp(value.lastSuccessfulCollectionAt) ||
    !nullableStamp(value.lastAttemptAt) ||
    !nullableStamp(value.lastFullCollectionAt) ||
    typeof value.latestCollectionFailed !== 'boolean' ||
    !nullableDate(value.observedUsageStart) ||
    !nullableDate(value.observedUsageEnd) ||
    !isChoice(value.state, COVERAGE_STATES) ||
    !Array.isArray(value.incompleteReasons) ||
    value.incompleteReasons.length > 32 ||
    !value.incompleteReasons.every((reason) => isText(reason, 128)) ||
    typeof value.temporalCompletenessClaimed !== 'boolean'
  ) {
    return null
  }
  return {
    hostId: value.hostId,
    requestedStart: value.requestedStart,
    requestedEnd: value.requestedEnd,
    lastSuccessfulCollectionAt: value.lastSuccessfulCollectionAt as string | null,
    lastAttemptAt: value.lastAttemptAt as string | null,
    lastFullCollectionAt: value.lastFullCollectionAt as string | null,
    latestCollectionFailed: value.latestCollectionFailed,
    observedUsageStart: value.observedUsageStart as string | null,
    observedUsageEnd: value.observedUsageEnd as string | null,
    state: value.state,
    incompleteReasons: value.incompleteReasons as string[],
    temporalCompletenessClaimed: value.temporalCompletenessClaimed,
  }
}

function interval(value: unknown): FleetInterval | null {
  if (
    !isObject(value) ||
    !isDate(value.startDateInclusive) ||
    !isDate(value.endDateInclusive) ||
    !isText(value.timezone, 64) ||
    !isText(value.dateSemantics, 64) ||
    value.startDateInclusive > value.endDateInclusive
  ) {
    return null
  }
  return {
    startDateInclusive: value.startDateInclusive,
    endDateInclusive: value.endDateInclusive,
    timezone: value.timezone,
    dateSemantics: value.dateSemantics,
  }
}

/**
 * Validate the versioned export and project only the fields this page uses. Producer
 * additions (quota observations, per-source authority tables) are dropped rather than
 * forwarded through the local API.
 */
export function parseFleetSlice(text: string): FleetSlice {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('the fleet export is not valid JSON')
  }
  if (!isObject(value)) throw new Error('the fleet export is not an object')
  if (value.schemaVersion !== FLEET_SCHEMA_VERSION) {
    throw new Error(`unsupported fleet export schema (expected ${FLEET_SCHEMA_VERSION})`)
  }
  const when = interval(value.requestedInterval)
  const lineage = value.eventLineage
  const authority = value.aggregateAuthority
  if (!isStamp(value.generatedAt) || !isStamp(value.asOf)) {
    throw new Error('the fleet export has no usable generatedAt/asOf')
  }
  if (!when) throw new Error('the fleet export has an invalid requestedInterval')
  if (
    !isObject(lineage) ||
    typeof lineage.eventIdsAvailable !== 'boolean' ||
    !(lineage.prospectiveCutoverAt === null || isStamp(lineage.prospectiveCutoverAt)) ||
    !isText(lineage.status, 64)
  ) {
    throw new Error('the fleet export has an invalid eventLineage')
  }
  if (
    !isObject(authority) ||
    typeof authority.authoritative !== 'boolean' ||
    !isText(authority.authority, 128) ||
    !isText(authority.relationshipToFleetTotals, 256)
  ) {
    throw new Error('the fleet export has an invalid aggregateAuthority')
  }
  if (!Array.isArray(value.usage) || value.usage.length > MAX_ROWS) {
    throw new Error('the fleet export has an invalid usage array')
  }
  if (!Array.isArray(value.coverage) || value.coverage.length > MAX_COVERAGE) {
    throw new Error('the fleet export has an invalid coverage array')
  }
  const rows: FleetUsageRow[] = []
  for (const entry of value.usage) {
    const row = usageRow(entry)
    if (!row) throw new Error('the fleet export has an invalid usage row')
    rows.push(row)
  }
  const coverage: FleetCoverageHost[] = []
  for (const entry of value.coverage) {
    const host = coverageHost(entry)
    if (!host) throw new Error('the fleet export has an invalid coverage entry')
    coverage.push(host)
  }
  const issues: { code: string; detail: string | null }[] = []
  if (value.issues !== undefined) {
    if (!Array.isArray(value.issues) || value.issues.length > MAX_ISSUES) {
      throw new Error('the fleet export has an invalid issues array')
    }
    for (const entry of value.issues) {
      if (!isObject(entry) || !isText(entry.code, 128)) {
        throw new Error('the fleet export has an invalid issue')
      }
      issues.push({
        code: entry.code,
        detail: isText(entry.detail, 512) ? entry.detail : null,
      })
    }
  }
  return {
    schemaVersion: FLEET_SCHEMA_VERSION,
    generatedAt: value.generatedAt,
    asOf: value.asOf,
    requestedInterval: when,
    eventLineage: {
      eventIdsAvailable: lineage.eventIdsAvailable,
      prospectiveCutoverAt: lineage.prospectiveCutoverAt as string | null,
      status: lineage.status,
    },
    aggregateAuthority: {
      authoritative: authority.authoritative,
      authority: authority.authority,
      relationshipToFleetTotals: authority.relationshipToFleetTotals,
    },
    usage: rows,
    coverage,
    issues,
  }
}

/**
 * Keep only rows whose `repositoryId` equals the configured ID, and hosts inside an
 * explicit host scope. Nothing is matched by basename, remote name or worktree directory,
 * so rows the producer did not map stay unassociated and are only counted.
 */
export function selectRepository(slice: FleetSlice, config: FleetConfig): FleetSelection {
  const scoped = config.hostIds.length > 0
  const inScope = (hostId: string): boolean => !scoped || config.hostIds.includes(hostId)
  const rows = slice.usage.filter(
    (row) => row.repositoryId === config.repositoryId && inScope(row.hostId),
  )
  const others = slice.usage.filter((row) => row.repositoryId !== config.repositoryId)
  const hostsOutsideScope = new Set(
    slice.usage
      .filter((row) => row.repositoryId === config.repositoryId && !inScope(row.hostId))
      .map((row) => row.hostId),
  )
  return {
    repositoryId: config.repositoryId,
    hostIds: config.hostIds,
    asOf: slice.asOf,
    generatedAt: slice.generatedAt,
    requestedInterval: slice.requestedInterval,
    eventLineage: slice.eventLineage,
    aggregateAuthority: slice.aggregateAuthority,
    rows,
    coverage: slice.coverage.filter((host) => inScope(host.hostId)),
    // Issue details are fleet-wide and can mention identities outside this repository's scope.
    issues: slice.issues.map(({ code }) => ({ code, detail: null })),
    unmatched: {
      rows: others.length,
      repositories: new Set(others.map((row) => row.repositoryId)).size,
      hostsOutsideScope: hostsOutsideScope.size,
    },
  }
}

/** A URL is usable only as plain http(s) with no embedded credentials. */
export function safeExternalUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
  if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.search) return null
  return url
}

const redactUrl = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}`

/** Parse the owner's config. Every failure is reported; nothing is guessed. */
export function parseFleetConfig(text: string): FleetConfig {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('fleet config is not valid JSON')
  }
  if (!isObject(value)) throw new Error('fleet config must be an object')
  const source = value.source
  if (!isObject(source)) throw new Error('fleet config needs a source with a path or url')
  const hasPath = source.path !== undefined
  const hasUrl = source.url !== undefined
  if (hasPath === hasUrl) throw new Error('fleet config source needs exactly one of path or url')
  if (!isText(value.repositoryId, 512)) {
    throw new Error('fleet config needs the repositoryId used in the producer mappings')
  }
  let resolved: FleetSource
  if (hasPath) {
    if (typeof source.path !== 'string' || !path.isAbsolute(source.path)) {
      throw new Error('fleet config source.path must be an absolute path')
    }
    resolved = {
      kind: 'file',
      label: path.normalize(source.path),
      path: path.normalize(source.path),
    }
  } else {
    const url = safeExternalUrl(source.url)
    if (!url) {
      throw new Error(
        'fleet config source.url must be http(s) without embedded credentials or query parameters',
      )
    }
    resolved = { kind: 'url', label: redactUrl(url), url: url.toString() }
  }
  let hostIds: string[] = []
  if (value.hostIds !== undefined) {
    if (
      !Array.isArray(value.hostIds) ||
      value.hostIds.length > 64 ||
      !value.hostIds.every((host) => isText(host, 256))
    ) {
      throw new Error('fleet config hostIds must be an array of host IDs')
    }
    hostIds = [...new Set(value.hostIds as string[])]
  }
  let fleetHistoryUrl: string | null = null
  if (value.fleetHistoryUrl !== undefined && value.fleetHistoryUrl !== null) {
    const url = safeExternalUrl(value.fleetHistoryUrl)
    if (!url) {
      throw new Error('fleet config fleetHistoryUrl must be http(s) without embedded credentials')
    }
    fleetHistoryUrl = url.toString()
  }
  return { source: resolved, repositoryId: value.repositoryId, hostIds, fleetHistoryUrl }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('the fleet export exceeds the size limit')
  }
  const body = response.body
  if (!body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength
    if (size > maxBytes) throw new Error('the fleet export exceeds the size limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Bound the actual descriptor read, including files replaced or grown during loading. */
async function readLocal(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('the configured fleet file is not a regular file')
    if (info.size > maxBytes) throw new Error('the fleet export exceeds the size limit')
    const buffer = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) return buffer.subarray(0, size).toString('utf8')
      size += bytesRead
    }
    throw new Error('the fleet export exceeds the size limit')
  } finally {
    await handle.close()
  }
}

/**
 * Owns the optional fleet slice: owner config, one bounded request-driven load at a time,
 * and a last-good cache under the repo's canonical-root-keyed Repo Pulse state dir.
 */
export class FleetUsageTracker {
  private readonly stateDir: string
  private readonly configPath: string
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly staleAfterMs: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private config: FleetConfig | null = null
  private configError: string | null = null
  private slice: FleetSlice | null = null
  private fetchedAt: number | null = null
  private fromCache = false
  private error: string | null = null
  /** Memoized as promises, not flags: two concurrent requests must not race past a pending read. */
  private configRead: Promise<void> | null = null
  private cacheRead: Promise<void> | null = null
  private inflight: Promise<FleetStatus> | null = null
  private controllers = new Set<AbortController>()
  private stopped = false

  constructor(stateDir: string, options: FleetTrackerOptions = {}) {
    this.stateDir = stateDir
    this.configPath = options.configPath ?? path.join(stateDir, CONFIG_FILE)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  /** Coalesced, request driven: concurrent callers share one load, and there is no timer. */
  async get(refresh = false): Promise<FleetStatus> {
    if (this.inflight) return this.inflight
    if (refresh) this.reset()
    this.inflight = (async () => {
      await this.loadConfig()
      if (!this.config) return this.status()
      await this.loadCache()
      if (!refresh && this.slice) return this.status()
      return this.load()
    })().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  stop(): void {
    this.stopped = true
    for (const controller of this.controllers) controller.abort()
  }

  /** Re-read the config file on the next request, for tests and owner edits. */
  reset(): void {
    this.configRead = null
    this.cacheRead = null
  }

  private loadConfig(): Promise<void> {
    this.configRead ??= this.readConfigFile()
    return this.configRead
  }

  private async readConfigFile(): Promise<void> {
    const previous = this.fingerprint()
    this.config = null
    this.configError = null
    try {
      this.config = parseFleetConfig(await readLocal(this.configPath, 16 * 1024))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.configError =
          error instanceof Error && !('code' in error)
            ? error.message
            : 'the fleet configuration could not be read'
      }
    }
    if (previous !== this.fingerprint()) {
      this.slice = null
      this.fetchedAt = null
      this.fromCache = false
      this.error = null
      this.cacheRead = null
    }
  }

  private loadCache(): Promise<void> {
    if (!this.config) return Promise.resolve()
    this.cacheRead ??= this.readCacheFile()
    return this.cacheRead
  }

  private async readCacheFile(): Promise<void> {
    try {
      const record = JSON.parse(await readLocal(this.cachePath(), this.maxBytes * 2)) as CacheRecord
      if (
        record.version === CACHE_VERSION &&
        record.configFingerprint === this.fingerprint() &&
        typeof record.fetchedAt === 'number' &&
        Number.isFinite(record.fetchedAt)
      ) {
        this.slice = parseFleetSlice(JSON.stringify(record.slice))
        this.fetchedAt = record.fetchedAt
        this.fromCache = true
      }
    } catch {
      // A missing or unusable cache just means the first request has to fetch.
    }
  }

  private async load(): Promise<FleetStatus> {
    const config = this.config
    if (!config) return this.status()
    if (this.stopped) {
      this.error = 'repo-pulse is shutting down'
      return this.status()
    }
    try {
      const text =
        config.source.kind === 'file'
          ? await this.readFileSource(config.source.path as string)
          : await this.readUrlSource(config.source.url as string)
      const slice = parseFleetSlice(text)
      this.slice = slice
      this.fetchedAt = this.now()
      this.fromCache = false
      this.error = null
      await this.persist(slice, this.fetchedAt)
    } catch (error) {
      // Keep the last good slice and say so; upstream bodies are never surfaced.
      this.error = error instanceof Error ? error.message : 'the fleet export could not be read'
    }
    return this.status()
  }

  private async readFileSource(file: string): Promise<string> {
    try {
      return await readLocal(file, this.maxBytes)
    } catch (error) {
      if (error instanceof Error && !('code' in error)) throw error
      throw new Error('the configured fleet export file is missing or unreadable')
    }
  }

  private async readUrlSource(url: string): Promise<string> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        // Status only: an upstream error page must not reach the local page.
        throw new Error(`the fleet export request failed with HTTP ${response.status}`)
      }
      return await readBounded(response, this.maxBytes)
    } catch (error) {
      const e = error as Error & { name?: string }
      if (this.stopped) throw new Error('repo-pulse is shutting down')
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        throw new Error(`the fleet export request timed out after ${this.timeoutMs}ms`)
      }
      if (e instanceof Error && /exceeds the size limit|failed with HTTP/.test(e.message)) throw e
      throw new Error('the configured fleet export could not be reached')
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
    }
  }

  status(): FleetStatus {
    const config = this.config
    const now = this.now()
    const times =
      this.slice && this.fetchedAt !== null
        ? [this.fetchedAt, Date.parse(this.slice.generatedAt), Date.parse(this.slice.asOf)]
        : []
    const stale = Boolean(
      this.slice &&
      (this.error !== null || times.some((at) => at > now || now - at > this.staleAfterMs)),
    )
    const state: FleetStatus['state'] = !config
      ? 'unconfigured'
      : !this.slice
        ? 'unavailable'
        : stale
          ? 'stale'
          : 'available'
    return {
      configured: Boolean(config),
      state,
      configError: this.configError,
      error: this.error,
      sourceKind: config?.source.kind ?? null,
      sourceLabel: config?.source.label ?? null,
      repositoryId: config?.repositoryId ?? null,
      hostIds: config?.hostIds ?? [],
      fleetHistoryUrl: config?.fleetHistoryUrl ?? null,
      configPath: this.configPath,
      fetchedAt: this.fetchedAt,
      stale,
      fromCache: this.fromCache,
      staleAfterMs: this.staleAfterMs,
      selection: config && this.slice ? selectRepository(this.slice, config) : null,
    }
  }

  private fingerprint(): string {
    const config = this.config
    if (!config) return 'none'
    return createHash('sha256')
      .update(
        JSON.stringify([
          config.source.kind,
          config.source.path ?? config.source.url,
          config.repositoryId,
          config.hostIds,
        ]),
      )
      .digest('hex')
      .slice(0, 16)
  }

  private cachePath(): string {
    const id = createHash('sha256').update(this.configPath).digest('hex').slice(0, 16)
    return path.join(this.stateDir, `fleet-usage-${id}.json`)
  }

  private async persist(slice: FleetSlice, fetchedAt: number): Promise<void> {
    const record: CacheRecord = {
      version: CACHE_VERSION,
      configFingerprint: this.fingerprint(),
      fetchedAt,
      slice,
    }
    try {
      await mkdir(this.stateDir, { recursive: true })
      const destination = this.cachePath()
      const temporary = `${destination}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
      await rename(temporary, destination)
    } catch (error) {
      console.error(
        'repo-pulse: could not cache the fleet slice',
        error instanceof Error ? error.message : error,
      )
    }
  }
}
