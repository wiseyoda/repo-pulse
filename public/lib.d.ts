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
