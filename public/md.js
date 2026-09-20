// A small CommonMark-ish renderer that keeps source line numbers, so a diff can be painted onto
// the rendered document. Pure: returns a tree of {t, a, c} nodes (tag, attrs, children) that the
// page materialises into DOM and the tests inspect directly. No HTML strings, so no injection.

const node = (t, a = {}, ...c) => ({
  t,
  a,
  c: c.flat().filter((x) => x !== null && x !== undefined && x !== false),
})

// --- inline ------------------------------------------------------------------

const INLINE_RE =
  /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(\*\*|__)(?=\S)([\s\S]*?\S)\7|(\*|_)(?=\S)([\s\S]*?\S)\9|~~(?=\S)([\s\S]*?\S)~~|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g

/** Inline markdown to nodes: code, images (as links), links, bold, italic, strike, autolinks. */
export function inline(text) {
  const out = []
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[2] !== undefined) out.push(node('code', {}, m[2].trim()))
    else if (m[3] !== undefined) out.push(node('a', { href: m[4], class: 'img' }, m[3] || m[4]))
    else if (m[5] !== undefined) out.push(node('a', { href: m[6] }, ...inline(m[5])))
    else if (m[8] !== undefined) out.push(node('strong', {}, ...inline(m[8])))
    else if (m[10] !== undefined) out.push(node('em', {}, ...inline(m[10])))
    else if (m[11] !== undefined) out.push(node('s', {}, ...inline(m[11])))
    else if (m[12] !== undefined) out.push(node('a', { href: m[12] }, m[12]))
    else if (m[13] !== undefined) out.push(node('a', { href: m[13] }, m[13]))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// --- blocks ------------------------------------------------------------------

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const TASK_RE = /^\[([ xX])\]\s+(.*)$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim())

/**
 * Parse markdown into blocks, each carrying the 1-based source lines it spans:
 * { kind, start, end, ... }. Lists are flat items with a depth, which render nests.
 */
export function parseBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let i = 0
  const n = lines.length
  while (i < n) {
    const line = lines[i]
    const lineNo = i + 1
    if (!line.trim()) {
      i++
      continue
    }
    let m
    if ((m = FENCE_RE.exec(line))) {
      const fence = m[1]
      const body = []
      let j = i + 1
      while (
        j < n &&
        !(
          lines[j].trim().startsWith(fence[0]) &&
          lines[j].trim().length >= fence.length &&
          /^[`~]+\s*$/.test(lines[j].trim())
        )
      ) {
        body.push({ line: j + 1, text: lines[j] })
        j++
      }
      blocks.push({ kind: 'code', start: lineNo, end: Math.min(n, j + 1), lang: m[2], body })
      i = j + 1
      continue
    }
    if ((m = HEADING_RE.exec(line))) {
      blocks.push({ kind: 'heading', start: lineNo, end: lineNo, level: m[1].length, text: m[2] })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr', start: lineNo, end: lineNo })
      i++
      continue
    }
    if ((m = QUOTE_RE.exec(line))) {
      const inner = []
      let j = i
      while (j < n && QUOTE_RE.test(lines[j])) {
        inner.push({ line: j + 1, text: QUOTE_RE.exec(lines[j])[1] })
        j++
      }
      blocks.push({ kind: 'quote', start: lineNo, end: j, lines: inner })
      i = j
      continue
    }
    if ((m = LIST_RE.exec(line))) {
      const items = []
      let j = i
      while (j < n) {
        const lm = LIST_RE.exec(lines[j])
        if (lm) {
          const task = TASK_RE.exec(lm[3])
          items.push({
            start: j + 1,
            end: j + 1,
            depth: Math.floor(lm[1].replace(/\t/g, '  ').length / 2),
            ordered: /\d/.test(lm[2]),
            checked: task ? task[1] !== ' ' : null,
            lines: [{ line: j + 1, text: task ? task[2] : lm[3] }],
          })
          j++
        } else if (lines[j].trim() && /^\s+/.test(lines[j]) && items.length) {
          // Continuation line of the previous item.
          const it = items[items.length - 1]
          it.lines.push({ line: j + 1, text: lines[j].trim() })
          it.end = j + 1
          j++
        } else break
      }
      blocks.push({ kind: 'list', start: lineNo, end: j, items })
      i = j
      continue
    }
    if (line.includes('|') && i + 1 < n && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitRow(line)
      const rows = []
      let j = i + 2
      while (j < n && lines[j].trim() && lines[j].includes('|')) {
        rows.push({ line: j + 1, cells: splitRow(lines[j]) })
        j++
      }
      blocks.push({ kind: 'table', start: lineNo, end: j, header, rows })
      i = j
      continue
    }
    // Paragraph: until a blank line or the start of another block.
    const para = []
    let j = i
    while (
      j < n &&
      lines[j].trim() &&
      !(
        j > i &&
        (FENCE_RE.test(lines[j]) ||
          HEADING_RE.test(lines[j]) ||
          HR_RE.test(lines[j]) ||
          QUOTE_RE.test(lines[j]) ||
          LIST_RE.test(lines[j]))
      )
    ) {
      para.push({ line: j + 1, text: lines[j].trim() })
      j++
    }
    blocks.push({ kind: 'p', start: lineNo, end: j, lines: para })
    i = j
  }
  return blocks
}

// --- render with diff marks --------------------------------------------------------

/**
 * Render markdown to nodes. `marks.added` is a Set of new-file line numbers that the diff added;
 * `marks.deleted` maps a new-file line number to the old lines that sat just before it. Added
 * lines are wrapped in <ins>, blocks that contain one are flagged, and deleted text is shown
 * struck through where it used to be, so a reader sees the document and the change at once.
 */
export function renderMarkdown(text, marks = { added: new Set(), deleted: new Map() }) {
  const blocks = parseBlocks(text)
  const out = []
  const pendingDeletes = [...marks.deleted.keys()].sort((a, b) => a - b)
  const flushDeleted = (upTo) => {
    while (pendingDeletes.length && pendingDeletes[0] <= upTo) {
      const at = pendingDeletes.shift()
      const old = marks.deleted.get(at)
      out.push(
        node('del', { class: 'gone', 'data-l': at }, ...old.map((t) => node('div', {}, t || ' '))),
      )
    }
  }
  const lineNode = (l) => {
    const content = inline(l.text)
    return marks.added.has(l.line) ? node('ins', { 'data-l': l.line }, ...content) : content
  }
  // A block with no added lines is parsed as one run, so emphasis can span source lines; one
  // with added lines is parsed per line, so the highlight lands exactly on what changed.
  const joinLines = (ls) =>
    ls.some((l) => marks.added.has(l.line))
      ? ls.flatMap((l, i) => (i ? [' ', lineNode(l)] : [lineNode(l)]))
      : inline(ls.map((l) => l.text).join(' '))
  const touched = (b) => {
    for (let l = b.start; l <= b.end; l++) if (marks.added.has(l)) return true
    return false
  }
  const attrs = (b, extra = {}) => ({
    ...extra,
    'data-l': b.start,
    class: [extra.class, touched(b) && 'ins-block'].filter(Boolean).join(' ') || undefined,
  })

  for (const b of blocks) {
    flushDeleted(b.start)
    switch (b.kind) {
      case 'heading':
        out.push(node(`h${b.level}`, attrs(b), ...lineNode({ line: b.start, text: b.text })))
        break
      case 'hr':
        out.push(node('hr', attrs(b)))
        break
      case 'code':
        out.push(
          node(
            'pre',
            attrs(b, { class: b.lang ? `lang-${b.lang}` : undefined }),
            node(
              'code',
              {},
              ...b.body.map((l) =>
                node(
                  'span',
                  { class: marks.added.has(l.line) ? 'ins' : undefined },
                  (l.text || ' ') + '\n',
                ),
              ),
            ),
          ),
        )
        break
      case 'quote':
        out.push(node('blockquote', attrs(b), node('p', {}, ...joinLines(b.lines))))
        break
      case 'p':
        out.push(node('p', attrs(b), ...joinLines(b.lines)))
        break
      case 'table':
        out.push(
          node(
            'table',
            attrs(b),
            node('thead', {}, node('tr', {}, ...b.header.map((c) => node('th', {}, ...inline(c))))),
            node(
              'tbody',
              {},
              ...b.rows.map((r) =>
                node(
                  'tr',
                  { class: marks.added.has(r.line) ? 'ins-row' : undefined, 'data-l': r.line },
                  ...r.cells.map((c) => node('td', {}, ...inline(c))),
                ),
              ),
            ),
          ),
        )
        break
      case 'list':
        out.push(renderList(b.items, 0, joinLines, attrs))
        break
    }
    flushDeleted(b.end)
  }
  flushDeleted(Infinity)
  return out
}

function renderList(items, depth, joinLines, attrs) {
  const ordered = items[0]?.ordered
  const children = []
  let i = 0
  while (i < items.length) {
    const it = items[i]
    if (it.depth < depth) break
    const sub = []
    let j = i + 1
    while (j < items.length && items[j].depth > it.depth) sub.push(items[j++])
    const li = node(
      'li',
      attrs(it, { class: it.checked === null ? undefined : it.checked ? 'task done' : 'task' }),
      it.checked !== null &&
        node('input', { type: 'checkbox', disabled: true, checked: it.checked || undefined }),
      ...joinLines(it.lines),
      sub.length ? renderList(sub, sub[0].depth, joinLines, attrs) : null,
    )
    children.push(li)
    i = j
  }
  return node(ordered ? 'ol' : 'ul', {}, ...children)
}

/** Diff lines from numberDiff → the marks renderMarkdown wants. */
export function marksFromDiff(lines) {
  const added = new Set()
  const deleted = new Map()
  for (const l of lines) {
    if (l.cls === 'add') added.add(l.new)
    else if (l.cls === 'del') {
      const list = deleted.get(l.at) ?? []
      list.push(l.text.slice(1))
      deleted.set(l.at, list)
    }
  }
  return { added, deleted }
}
