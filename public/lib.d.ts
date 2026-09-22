export const DEFAULT_ITEM_PATTERN: string
export function extractItems(text: string, pattern: string): string[]
export interface CommitLike {
  subject: string
  ts: number
  added: number
  deleted: number
  files: { path: string }[]
}
export interface ItemRollup {
  item: string
  commits: number
  added: number
  deleted: number
  files: number
  last: number
  subjects: string[]
}
export function rollupCommits(commits: CommitLike[], pattern: string, since: number): ItemRollup[]
export function magnitudeWidth(n: number, max?: number): number
export function relativeTime(ts: number, now: number): string
export function splitPath(p: string): { dir: string; base: string }
export function mergeFeed<T extends { ts: number; id: number }>(
  edits: T[],
  commits: T[],
  heads: T[],
  since: number,
): T[]
export interface DiffLine {
  cls: 'file' | 'meta' | 'head' | 'hunk' | 'add' | 'del' | 'ctx'
  text: string
  old?: number
  new?: number
  /** For a deleted line: the new-file line number it sat before. */
  at?: number
  path?: string
}
export function numberDiff(text: string): DiffLine[]
export function feedTotals(rows: { type: string; dAdded?: number; dDeleted?: number }[]): {
  added: number
  deleted: number
  edits: number
  commits: number
}

export interface RepostatHotspot {
  file: string
  function: string
  cyclomatic: number
  cognitive: number
  lines: number
}
export interface RepostatRisk {
  file: string
  churnCount: number
  maxComplexity: number
}
export function repostatSummary(metrics: {
  totalFiles: number
  totalLines: { code: number }
  hotspots: RepostatHotspot[]
  documentation: { docToCodeRatio: number } | null
  skippedFiles: number
  riskHotspots: RepostatRisk[]
}): {
  files: number
  codeLines: number
  maxCyclomatic: number
  maxCognitive: number
  documentationRatio: number | null
  skippedFiles: number
  hotspots: RepostatHotspot[]
  risks: RepostatRisk[]
}

export interface EditLike {
  ts: number
  path: string
  dAdded: number
  dDeleted: number
}
export interface Bucket {
  t: number
  added: number
  deleted: number
  edits: number
  commits: number
}
export function bucketFor(windowMs: number): number
export function bucketActivity(
  edits: EditLike[],
  commits: { ts: number }[],
  since: number,
  now: number,
  bucketMs: number,
): Bucket[]
export function isTestPath(p: string): boolean
export function testShare(edits: EditLike[]): { test: number; other: number; share: number }
export function churnBy(
  edits: EditLike[],
  depth?: number,
): { key: string; added: number; deleted: number; edits: number; files: number; total: number }[]
export function commitTypes(commits: { subject: string }[]): { type: string; n: number }[]
export function tempo(
  edits: EditLike[],
  commits: { ts: number }[],
  since: number,
  now: number,
): {
  activeMinutes: number
  gapMs: number
  gapEnd: number
  busiest: { minute: number; edits: number }
}
export function sizeTrend(
  commits: { ts: number; added: number; deleted: number; sha: string }[],
): { ts: number; net: number; sha: string }[]
export function extMix(
  counts: { ext: string; n: number }[],
  keep?: number,
): { ext: string; n: number; share: number }[]
export function compact(n: number): string

export interface UsageLike {
  ts: number
  tool: string
  seat: string
  session: string
  model: string
  branch: string | null
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  usd: number | null
  calls?: number
}
export function usageTotals(entries: UsageLike[]): {
  usd: number
  tokens: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  n: number
  unpriced: number
  sessions: number
  cacheHit: number
}
export function groupUsage(
  entries: UsageLike[],
  keyOf: (e: UsageLike) => string,
): {
  key: string
  usd: number
  tokens: number
  n: number
  output: number
  unpriced: number
  sessions: number
}[]
export function bucketUsage(
  entries: UsageLike[],
  since: number,
  now: number,
  bucketMs: number,
  seriesOf: (e: UsageLike) => string,
  valueOf: (e: UsageLike) => number,
): { t: number; values: Record<string, number> }[]
export function itemForUsage(
  entry: UsageLike,
  commitsAsc: { ts: number; subject: string }[],
  pattern: string,
  horizonMs?: number,
): string | null
export function usageSessions(entries: UsageLike[]): {
  key: string
  tool: string
  seat: string
  session: string
  first: number
  last: number
  models: string[]
  branch: string | null
  tokens: number
  output: number
  usd: number
  n: number
}[]
export function fmtUsd(n: number): string

import type { FleetCoverageHost, FleetInterval, FleetUsageRow } from '../src/fleet-usage.ts'

export function fleetTotals(rows: FleetUsageRow[]): {
  tokens: number
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  rows: number
  usd: number | null
  pricedUsd: number
  unpricedRows: number
  subscriptionRows: number
  billedRows: number
  cacheHit: number
  hosts: string[]
  sources: string[]
  models: string[]
  days: string[]
}
export function fleetGroup(
  rows: FleetUsageRow[],
  keyOf: (row: FleetUsageRow) => string,
): {
  key: string
  tokens: number
  output: number
  usd: number | null
  pricedUsd: number
  unpricedRows: number
  rows: number
}[]
export function fleetDays(
  rows: FleetUsageRow[],
  interval?: FleetInterval | null,
): { date: string; tokens: number; usd: number; unpricedRows: number }[]
export function fleetCoverageSummary(
  coverage: FleetCoverageHost[],
  asOf: string | number,
): {
  hosts: {
    hostId: string
    state: string
    collectedAt: number | null
    behindMs: number | null
    latestCollectionFailed: boolean
    observedUsageEnd: string | null
    incompleteReasons: string[]
  }[]
  total: number
  incomplete: number
  failed: number
  neverCollected: number
  oldestSuccess: number | null
  complete: boolean
  reasons: { reason: string; hosts: number }[]
}
export function fleetIdentityNotes(rows: FleetUsageRow[]): {
  identityConfidence: { key: string; rows: number }[]
  temporalConfidence: { key: string; rows: number }[]
  aggregateBases: { key: string; rows: number }[]
  weakestIdentity: string | null
  weakestTemporal: string | null
}
