// Pure helpers shared by the page and the test suite. No DOM access here.

export const DEFAULT_ITEM_PATTERN = '\\b[A-Z]{1,4}-\\d+\\b'

/** Unique work-item ids in a string, in first-seen order. */
export function extractItems(text, pattern) {
  const re = new RegExp(pattern, 'g')
  const seen = new Set()
  for (const m of text.matchAll(re)) seen.add(m[0])
  return [...seen]
}

/**
 * Group commits by work item within a time window. A commit naming two items counts
 * toward both. Commits naming none land under `unlabeled`.
 */
export function rollupCommits(commits, pattern, since) {
  const groups = new Map()
  for (const c of commits) {
    if (c.ts < since) continue
    const items = extractItems(c.subject, pattern)
    const keys = items.length ? items : ['unlabeled']
    for (const key of keys) {
      let g = groups.get(key)
      if (!g) {
        g = { item: key, commits: 0, added: 0, deleted: 0, files: new Set(), last: 0, subjects: [] }
        groups.set(key, g)
      }
      g.commits++
      g.added += c.added
      g.deleted += c.deleted
      for (const f of c.files) g.files.add(f.path)
      if (c.ts > g.last) g.last = c.ts
      if (g.subjects.length < 3) g.subjects.push(c.subject)
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, files: g.files.size }))
    .sort((a, b) => b.last - a.last)
}

/** Log-scaled width in px for a change of `n` lines, so a 1-line tweak and a 400-line rewrite both read. */
export function magnitudeWidth(n, max = 64) {
  if (n <= 0) return 0
  return Math.min(max, Math.round(6 * Math.log2(1 + n)))
}

export function relativeTime(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function splitPath(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) }
}

/** Merge edits and commits into one feed, newest first. */
export function mergeFeed(edits, commits, heads, since) {
  const rows = []
  for (const e of edits) if (e.ts >= since) rows.push(e)
  for (const c of commits) if (c.ts >= since) rows.push(c)
  for (const h of heads) if (h.ts >= since) rows.push(h)
  return rows.sort((a, b) => b.ts - a.ts || b.id - a.id)
}

/**
 * Give every line of a unified diff its old/new line numbers and a class. Hunk headers reset
 * the counters; file headers, metadata, and anything before the first hunk (a commit message,
 * a stat block) carry none. Pure, so the page and tests share it.
 */
export function numberDiff(text) {
  const out = []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  let oldNo = 0
  let newNo = 0
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      inHunk = false
      out.push({ cls: 'file', text: line, path: line.replace(/^diff --git a\/.* b\//, '') })
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      inHunk = true
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      out.push({ cls: 'hunk', text: line })
      continue
    }
    if (!inHunk) {
      const meta =
        /^(\+\+\+|---|index |new file|deleted file|similarity|rename |old mode|new mode|Binary )/.test(
          line,
        )
      out.push({ cls: meta ? 'meta' : 'head', text: line })
      continue
    }
    if (line.startsWith('+')) out.push({ cls: 'add', new: newNo++, text: line })
    else if (line.startsWith('-')) out.push({ cls: 'del', old: oldNo++, text: line })
    else if (line.startsWith('\\')) out.push({ cls: 'meta', text: line })
    else out.push({ cls: 'ctx', old: oldNo++, new: newNo++, text: line })
  }
  return out
}

/** Sum of every row's net change, so a window's total reads at a glance. */
export function feedTotals(rows) {
  let added = 0
  let deleted = 0
  let edits = 0
  let commits = 0
  for (const r of rows) {
    if (r.type === 'edit') {
      edits++
      added += Math.max(0, r.dAdded) + Math.max(0, -r.dDeleted)
      deleted += Math.max(0, r.dDeleted) + Math.max(0, -r.dAdded)
    } else if (r.type === 'commit') commits++
  }
  return { added, deleted, edits, commits }
}
