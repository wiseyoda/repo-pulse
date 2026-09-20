export interface MdNode {
  t: string
  a: Record<string, string | number | boolean | undefined>
  c: (MdNode | string)[]
}
export interface Marks {
  added: Set<number>
  deleted: Map<number, string[]>
}
export function inline(text: string): (MdNode | string)[]
export function parseBlocks(text: string): { kind: string; start: number; end: number }[]
export function renderMarkdown(text: string, marks?: Marks): MdNode[]
export function marksFromDiff(
  lines: { cls: string; new?: number; at?: number; text: string }[],
): Marks
