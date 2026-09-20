import { describe, expect, it } from 'vitest'
import { numberDiff } from '../public/lib.js'
import { inline, marksFromDiff, parseBlocks, renderMarkdown, type MdNode } from '../public/md.js'

const tags = (nodes: (MdNode | string)[]) => nodes.map((n) => (typeof n === 'string' ? n : n.t))
const text = (n: MdNode | string): string => (typeof n === 'string' ? n : n.c.map(text).join(''))

describe('inline', () => {
  it('handles code, links, emphasis, strike, and autolinks without nesting mistakes', () => {
    const out = inline('use `a*b*` and **bold _in_** ~~gone~~ [t](https://x.y) https://z.z/p')
    expect(tags(out)).toEqual(['use ', 'code', ' and ', 'strong', ' ', 's', ' ', 'a', ' ', 'a'])
    expect(text(out[1]!)).toBe('a*b*')
    expect(tags((out[3] as MdNode).c)).toEqual(['bold ', 'em'])
    expect((out[7] as MdNode).a.href).toBe('https://x.y')
  })
})

describe('parseBlocks', () => {
  it('splits headings, lists with tasks and nesting, fences, quotes, tables, and paragraphs', () => {
    const md = [
      '# Title',
      '',
      'para line one',
      'para line two',
      '',
      '- [ ] W-001 open',
      '- [x] W-002 done',
      '  - nested',
      '',
      '```py',
      'x = 1',
      '```',
      '> quoted',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '---',
    ].join('\n')
    const blocks = parseBlocks(md)
    expect(blocks.map((b) => [b.kind, b.start, b.end])).toEqual([
      ['heading', 1, 1],
      ['p', 3, 4],
      ['list', 6, 8],
      ['code', 10, 12],
      ['quote', 13, 13],
      ['table', 15, 17],
      ['hr', 18, 18],
    ])
    const list = blocks[2] as unknown as { items: { depth: number; checked: boolean | null }[] }
    expect(list.items.map((i) => [i.depth, i.checked])).toEqual([
      [0, false],
      [0, true],
      [1, null],
    ])
  })
})

describe('renderMarkdown with marks', () => {
  it('wraps added lines in ins, flags their block, and shows deleted text where it was', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' # Title', '-old line', '+new line', ' tail'].join('\n')
    const marks = marksFromDiff(numberDiff(diff))
    expect([...marks.added]).toEqual([2])
    expect(marks.deleted.get(2)).toEqual(['old line'])
    const out = renderMarkdown('# Title\nnew line\ntail', marks)
    expect(out.map((n) => n.t)).toEqual(['h1', 'del', 'p'])
    const p = out[2]!
    expect(p.a.class).toBe('ins-block')
    expect(tags(p.c)).toEqual(['ins', ' ', 'tail'])
    expect(text(out[1]!)).toBe('old line')
  })
  it('lets emphasis span source lines when nothing in the block changed', () => {
    const out = renderMarkdown('one **two\nthree** four')
    expect(tags(out[0]!.c)).toEqual(['one ', 'strong', ' four'])
    const marked = renderMarkdown('one **two\nthree** four', {
      added: new Set([2]),
      deleted: new Map(),
    })
    expect(tags(marked[0]!.c)).toEqual(['one **two', ' ', 'ins'])
  })
  it('renders task lists as disabled checkboxes and nests sub-items', () => {
    const out = renderMarkdown('- [x] done\n  - child\n- [ ] todo')
    expect(out[0]!.t).toBe('ul')
    const first = out[0]!.c[0] as MdNode
    expect(first.a.class).toBe('task done')
    expect(tags(first.c)).toEqual(['input', 'done', 'ul'])
  })
})
