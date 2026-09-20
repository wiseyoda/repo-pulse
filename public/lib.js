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
    else if (line.startsWith('-')) out.push({ cls: 'del', old: oldNo++, at: newNo, text: line })
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

// --- stats -------------------------------------------------------------------

/** Bucket width that gives a window roughly 40-90 columns. */
export function bucketFor(windowMs) {
  if (!windowMs) return 3_600_000
  if (windowMs <= 15 * 60_000) return 15_000
  if (windowMs <= 60 * 60_000) return 60_000
  if (windowMs <= 3 * 60 * 60_000) return 3 * 60_000
  if (windowMs <= 24 * 60 * 60_000) return 20 * 60_000
  return 3_600_000
}

/**
 * Lines added and deleted per time bucket across a window, with edit and commit counts.
 * A revert counts as deleted lines. Buckets cover the whole window so quiet time shows.
 */
export function bucketActivity(edits, commits, since, now, bucketMs) {
  const start = Math.floor(since / bucketMs) * bucketMs
  const n = Math.max(1, Math.ceil((now - start) / bucketMs))
  const out = Array.from({ length: n }, (_, i) => ({
    t: start + i * bucketMs,
    added: 0,
    deleted: 0,
    edits: 0,
    commits: 0,
  }))
  const at = (ts) => out[Math.min(n - 1, Math.max(0, Math.floor((ts - start) / bucketMs)))]
  for (const e of edits) {
    if (e.ts < since) continue
    const b = at(e.ts)
    b.edits++
    b.added += Math.max(0, e.dAdded) + Math.max(0, -e.dDeleted)
    b.deleted += Math.max(0, e.dDeleted) + Math.max(0, -e.dAdded)
  }
  for (const c of commits) if (c.ts >= since) at(c.ts).commits++
  return out
}

const TEST_RE =
  /(^|\/)(tests?|specs?|__tests__|testing|e2e|cypress|fixtures?)(\/|$)|(\.|_)(test|spec)s?\.[^/]+$|(^|\/)test_[^/]+$|(^|\/)conftest\.py$/i
/** Heuristic that works across ecosystems: a test dir anywhere in the path or a test-named file. */
export function isTestPath(p) {
  return TEST_RE.test(p)
}

/** Lines changed in test files vs everything else, and the share as a 0-1 ratio. */
export function testShare(edits) {
  let test = 0
  let other = 0
  for (const e of edits) {
    const n = Math.abs(e.dAdded) + Math.abs(e.dDeleted)
    if (isTestPath(e.path)) test += n
    else other += n
  }
  return { test, other, share: test + other ? test / (test + other) : 0 }
}

/** Lines changed per top-level directory (or per file when `depth` is Infinity), largest first. */
export function churnBy(edits, depth = 1) {
  const m = new Map()
  for (const e of edits) {
    const parts = e.path.split('/')
    const key =
      depth === Infinity
        ? e.path
        : parts.slice(0, Math.min(depth, parts.length - 1)).join('/') || '·'
    const g = m.get(key) ?? { key, added: 0, deleted: 0, edits: 0, files: new Set() }
    g.added += Math.max(0, e.dAdded) + Math.max(0, -e.dDeleted)
    g.deleted += Math.max(0, e.dDeleted) + Math.max(0, -e.dAdded)
    g.edits++
    g.files.add(e.path)
    m.set(key, g)
  }
  return [...m.values()]
    .map((g) => ({ ...g, files: g.files.size, total: g.added + g.deleted }))
    .sort((a, b) => b.total - a.total || b.edits - a.edits)
}

const TYPE_RE = /^(\w+)(\([^)]*\))?!?:\s/
/** Conventional-commit types in a window; anything else is "other". Largest first. */
export function commitTypes(commits) {
  const m = new Map()
  for (const c of commits) {
    const t = TYPE_RE.exec(c.subject)?.[1]?.toLowerCase() ?? 'other'
    m.set(t, (m.get(t) ?? 0) + 1)
  }
  return [...m].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n)
}

/** Minutes with at least one edit or commit, the longest quiet gap, and the busiest minute. */
export function tempo(edits, commits, since, now) {
  const minutes = new Map()
  const stamps = []
  for (const e of edits) {
    if (e.ts < since) continue
    const m = Math.floor(e.ts / 60_000)
    minutes.set(m, (minutes.get(m) ?? 0) + 1)
    stamps.push(e.ts)
  }
  for (const c of commits) {
    if (c.ts < since) continue
    minutes.set(Math.floor(c.ts / 60_000), (minutes.get(Math.floor(c.ts / 60_000)) ?? 0) + 1)
    stamps.push(c.ts)
  }
  stamps.sort((a, b) => a - b)
  let gap = 0
  let gapEnd = 0
  let prev = since
  for (const t of [...stamps, now]) {
    if (t - prev > gap) {
      gap = t - prev
      gapEnd = t
    }
    prev = t
  }
  let busiest = { minute: 0, edits: 0 }
  for (const [minute, n] of minutes)
    if (n > busiest.edits) busiest = { minute: minute * 60_000, edits: n }
  return { activeMinutes: minutes.size, gapMs: gap, gapEnd, busiest }
}

/** Net repo size change per commit, cumulative and oldest first, for a trend line. */
export function sizeTrend(commits) {
  const sorted = [...commits].sort((a, b) => a.ts - b.ts)
  let net = 0
  return sorted.map((c) => {
    net += c.added - c.deleted
    return { ts: c.ts, net, sha: c.sha }
  })
}

/** Share of files by extension, top `keep` plus "other". */
export function extMix(counts, keep = 5) {
  const total = counts.reduce((n, c) => n + c.n, 0)
  const sorted = [...counts].sort((a, b) => b.n - a.n)
  const top = sorted.slice(0, keep)
  const rest = sorted.slice(keep).reduce((n, c) => n + c.n, 0)
  const out = top.map((c) => ({ ext: c.ext, n: c.n, share: total ? c.n / total : 0 }))
  if (rest) out.push({ ext: 'other', n: rest, share: total ? rest / total : 0 })
  return out
}

/** Compact number for tiles: 1,284 / 12.9K / 1.2M. */
export function compact(n) {
  const a = Math.abs(n)
  if (a < 10_000) return n.toLocaleString()
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 100_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// --- llm usage ---------------------------------------------------------------

const USAGE_TOKENS = (e) => e.input + e.output + e.cacheWrite + e.cacheRead

/** Totals across entries: tokens by class, API-equivalent cost, cache hit ratio, unpriced count. */
export function usageTotals(entries) {
  const t = {
    usd: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    n: 0,
    unpriced: 0,
    sessions: new Set(),
  }
  for (const e of entries) {
    t.n++
    t.input += e.input
    t.output += e.output
    t.cacheWrite += e.cacheWrite
    t.cacheRead += e.cacheRead
    t.tokens += USAGE_TOKENS(e)
    if (e.usd === null || e.usd === undefined) t.unpriced++
    else t.usd += e.usd
    t.sessions.add(`${e.tool}:${e.session}`)
  }
  const prompt = t.input + t.cacheWrite + t.cacheRead
  return { ...t, sessions: t.sessions.size, cacheHit: prompt ? t.cacheRead / prompt : 0 }
}

/** Entries grouped by `keyOf`, each with totals, sorted by cost then tokens. */
export function groupUsage(entries, keyOf) {
  const m = new Map()
  for (const e of entries) {
    const k = keyOf(e)
    const g = m.get(k) ?? {
      key: k,
      usd: 0,
      tokens: 0,
      n: 0,
      output: 0,
      unpriced: 0,
      sessions: new Set(),
    }
    g.n++
    g.tokens += USAGE_TOKENS(e)
    g.output += e.output
    if (e.usd === null || e.usd === undefined) g.unpriced++
    else g.usd += e.usd
    g.sessions.add(`${e.tool}:${e.session}`)
    m.set(k, g)
  }
  return [...m.values()]
    .map((g) => ({ ...g, sessions: g.sessions.size }))
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens)
}

/** Per-bucket sums of `valueOf` split by `seriesOf`, covering the whole window. */
export function bucketUsage(entries, since, now, bucketMs, seriesOf, valueOf) {
  const start = Math.floor(since / bucketMs) * bucketMs
  const n = Math.max(1, Math.ceil((now - start) / bucketMs))
  const out = Array.from({ length: n }, (_, i) => ({ t: start + i * bucketMs, values: {} }))
  for (const e of entries) {
    if (e.ts < since) continue
    const b = out[Math.min(n - 1, Math.max(0, Math.floor((e.ts - start) / bucketMs)))]
    const k = seriesOf(e)
    b.values[k] = (b.values[k] ?? 0) + valueOf(e)
  }
  return out
}

/**
 * Which work item an entry served: an id in the branch name wins; otherwise the next commit
 * after it (within `horizonMs`) names it, since a turn's work lands in the commit that follows.
 */
export function itemForUsage(entry, commitsAsc, pattern, horizonMs = 12 * 3_600_000) {
  const re = new RegExp(pattern, 'g')
  if (entry.branch) {
    const m = entry.branch.match(re)
    if (m) return m[0]
  }
  // Binary search for the first commit at or after the entry.
  let lo = 0
  let hi = commitsAsc.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (commitsAsc[mid].ts < entry.ts) lo = mid + 1
    else hi = mid
  }
  const c = commitsAsc[lo]
  if (!c || c.ts - entry.ts > horizonMs) return null
  const ids = extractItems(c.subject, pattern)
  return ids[0] ?? null
}

/** One row per session: span, models, tokens, cost, branch; newest first. */
export function usageSessions(entries) {
  const m = new Map()
  for (const e of entries) {
    const k = `${e.tool}:${e.seat}:${e.session}`
    const s = m.get(k) ?? {
      key: k,
      tool: e.tool,
      seat: e.seat,
      session: e.session,
      first: e.ts,
      last: e.ts,
      models: new Set(),
      branch: null,
      tokens: 0,
      output: 0,
      usd: 0,
      n: 0,
    }
    s.first = Math.min(s.first, e.ts)
    s.last = Math.max(s.last, e.ts)
    s.models.add(e.model)
    if (e.branch) s.branch = e.branch
    s.tokens += USAGE_TOKENS(e)
    s.output += e.output
    s.usd += e.usd ?? 0
    s.n++
    m.set(k, s)
  }
  return [...m.values()]
    .map((s) => ({ ...s, models: [...s.models] }))
    .sort((a, b) => b.last - a.last)
}

export function fmtUsd(n) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 10) return `$${n.toFixed(1)}`
  if (n >= 0.01) return `$${n.toFixed(2)}`
  return n > 0 ? '<$0.01' : '$0'
}
