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
