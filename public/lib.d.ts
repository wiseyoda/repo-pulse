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
