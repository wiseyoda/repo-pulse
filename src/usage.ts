// Per-repo LLM usage: finds every coding-agent transcript on this machine whose working
// directory is inside the repo, counts tokens the way each tool's own accounting does, and
// keeps the result under ~/.repo-usage/<repo>/. Reads usage and metadata fields only, never
// message content.

import { existsSync } from 'node:fs'
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { conversationEvents, readConversation } from './antigravity.ts'

export type Tool = 'claude' | 'codex' | 'grok' | 'antigravity'
export const TOOLS: Tool[] = ['claude', 'codex', 'grok', 'antigravity']
/** Bump when cursor semantics change so cached skip decisions are re-made. */
export const CURSOR_VERSION = 4

export interface UsageEntry {
  /** Stable identity so a re-read replaces rather than double counts. */
  key: string
  tool: Tool
  /** Which config dir it came from: "claude", "claude-yoda", "codex-p423", ... */
  seat: string
  session: string
  ts: number
  model: string
  cwd: string
  branch: string | null
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** A subagent / sidechain turn. */
  side: boolean
  /** Cost the tool itself reported in USD, when it does (Grok). */
  cost?: number
  /** Model calls this entry stands for when it is a session roll-up (Grok, Antigravity). */
  calls?: number
}

export interface UsageConfig {
  enabled: boolean
  repo: string
  remote: string | null
  roots: string[]
  sources: Record<Tool, boolean>
  createdAt: number
}

export interface Source {
  tool: Tool
  seat: string
  dir: string
}

export const USAGE_HOME = path.join(os.homedir(), '.repo-usage')

// --- config ------------------------------------------------------------------------

/** "wiseyoda/repo-pulse" → "repo-pulse"; ssh and https remotes alike. Null when unparseable. */
export function repoNameFromRemote(url: string): string | null {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m?.[1] || null
}

export function usageDir(repo: string): string {
  return path.join(USAGE_HOME, repo)
}

export async function readConfig(repo: string): Promise<UsageConfig | null> {
  try {
    return JSON.parse(await readFile(path.join(usageDir(repo), 'config.json'), 'utf8'))
  } catch {
    return null
  }
}

export async function writeConfig(cfg: UsageConfig): Promise<void> {
  const dir = usageDir(cfg.repo)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n')
}

// --- discovery -----------------------------------------------------------------------

/** Every agent config dir on this machine, including per-seat copies (~/.claude-yoda, ~/.codex-p423). */
export async function discoverSources(home = os.homedir()): Promise<Source[]> {
  const out: Source[] = []
  let names: string[] = []
  try {
    names = await readdir(home)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    const dir = path.join(home, name)
    if (/^\.claude(-[\w.-]+)?$/.test(name) && existsSync(path.join(dir, 'projects'))) {
      out.push({ tool: 'claude', seat: name.slice(1), dir: path.join(dir, 'projects') })
    } else if (/^\.codex(-[\w.-]+)?$/.test(name) && existsSync(path.join(dir, 'sessions'))) {
      out.push({ tool: 'codex', seat: name.slice(1), dir: path.join(dir, 'sessions') })
    } else if (/^\.grok(-[\w.-]+)?$/.test(name) && existsSync(path.join(dir, 'sessions'))) {
      out.push({ tool: 'grok', seat: name.slice(1), dir: path.join(dir, 'sessions') })
    }
    if (/^\.gemini(-[\w.-]+)?$/.test(name)) {
      for (const sub of ['antigravity', 'antigravity-cli', 'antigravity-ide']) {
        const root = path.join(dir, sub)
        if (existsSync(path.join(root, 'conversation_summaries.db')))
          out.push({ tool: 'antigravity', seat: `${name.slice(1)}/${sub}`, dir: root })
      }
    }
  }
  return out
}

export function underRoots(cwd: string | undefined, roots: string[]): boolean {
  if (!cwd) return false
  return roots.some((r) => cwd === r || cwd.startsWith(r.endsWith('/') ? r : r + '/'))
}

/** Claude Code names a project dir after the launch cwd with every non-alphanumeric run as "-". */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]+/g, '-')
}

// --- parsers (pure) --------------------------------------------------------------------

const SYNTHETIC = '<synthetic>'

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0)

interface ClaudeCtx {
  seat: string
  roots: string[]
  session: string
}

/**
 * Claude Code transcript lines → entries. Streaming rewrites a message several times, so the
 * caller's store keeps the copy with the largest total (non-sidechain preferred): ccusage's rule.
 */
export function parseClaudeLines(lines: Iterable<string>, ctx: ClaudeCtx): UsageEntry[] {
  const out: UsageEntry[] = []
  let sessionCwd: string | undefined
  let anon = 0
  for (const line of lines) {
    if (!line || !line.includes('"usage"')) {
      if (line && sessionCwd === undefined && line.includes('"cwd"')) {
        try {
          const r = JSON.parse(line)
          if (typeof r.cwd === 'string') sessionCwd = r.cwd
        } catch {}
      }
      continue
    }
    let r: any
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof r.cwd === 'string' && sessionCwd === undefined) sessionCwd = r.cwd
    if (r.type !== 'assistant') continue
    const msg = r.message
    const usage = msg?.usage
    if (!usage || typeof usage !== 'object') continue
    const model = typeof msg.model === 'string' ? msg.model : 'unknown'
    if (model === SYNTHETIC) continue
    const ts = Date.parse(r.timestamp)
    if (!Number.isFinite(ts)) continue
    const cwd = typeof r.cwd === 'string' ? r.cwd : (sessionCwd ?? '')
    if (!underRoots(cwd, ctx.roots)) continue
    const side = Boolean(r.isSidechain)
    const branch = typeof r.gitBranch === 'string' ? r.gitBranch : null
    const mid: string | undefined = msg.id
    const rid: string | undefined = r.requestId
    const base = {
      tool: 'claude' as const,
      seat: ctx.seat,
      session: ctx.session,
      ts,
      cwd,
      branch,
      side,
    }
    const pushEntry = (idKey: string | null, m: string, u: any) => {
      out.push({
        key: idKey ? `c:${idKey}:${rid ?? ''}` : `c:anon:${ctx.session}:${anon++}`,
        ...base,
        model: m,
        input: n(u.input_tokens),
        output: n(u.output_tokens),
        cacheWrite: n(u.cache_creation_input_tokens),
        cacheRead: n(u.cache_read_input_tokens),
      })
    }
    pushEntry(mid ?? null, model, usage)
    // A second model consulted inside the same message counts under its own name.
    const iterations = Array.isArray(usage.iterations) ? usage.iterations : []
    iterations.forEach((it: any, i: number) => {
      if (it && it.type === 'advisor_message' && typeof it.model === 'string')
        pushEntry(mid ? `${mid}:advisor:${i}` : null, it.model, it)
    })
  }
  return out
}

interface CodexCtx {
  seat: string
  roots: string[]
}

const CODEX_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
] as const

/**
 * A whole Codex rollout → entries, mirroring ccusage: one entry per token_count event with a
 * new total, keyed on (timestamp, model, usage tuple). A fork or resume replays the parent's
 * history as a sub-second burst at the head of the file; that burst is skipped.
 */
export function parseCodexFile(text: string, ctx: CodexCtx): UsageEntry[] {
  const out: UsageEntry[] = []
  let session = ''
  let cwd = ''
  let model = 'unknown'
  let side = false
  let prevTotals: number[] | null = null
  let prevMs: number | null = null
  let inBurst: boolean | null = null
  let firstIndex = -1
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line) continue
    let r: any
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const p = r.payload ?? {}
    if (r.type === 'session_meta') {
      session = p.id ?? p.session_id ?? session
      cwd = p.cwd ?? cwd
      side = Boolean(p.source && typeof p.source === 'object' && 'subagent' in p.source)
      continue
    }
    if (r.type === 'turn_context') {
      model = p.model ?? model
      cwd = p.cwd ?? cwd
      continue
    }
    if (r.type !== 'event_msg' || p.type !== 'token_count') continue
    const ts = Date.parse(r.timestamp)
    if (!Number.isFinite(ts)) continue
    const info = p.info ?? {}
    const total = info.total_token_usage
    const last = info.last_token_usage
    const totalT = total ? CODEX_FIELDS.map((k) => n(total[k])) : null
    const advanced =
      totalT === null || prevTotals === null || totalT.some((v, i) => v !== prevTotals![i])
    let tuple: number[] | null = null
    if (last && advanced) tuple = CODEX_FIELDS.map((k) => n(last[k]))
    else if (totalT) {
      const basis = prevTotals ?? [0, 0, 0, 0, 0]
      tuple = totalT.map((v, i) => Math.max(0, v - basis[i]!))
    }
    if (totalT) prevTotals = totalT
    // Burst detection: two usage events within a second at the head of a file are replay.
    let skip = false
    if (prevMs === null) prevMs = ts
    else {
      const gap = ts - prevMs
      prevMs = ts
      if (inBurst === null) {
        inBurst = gap >= 0 && gap <= 1000
        skip = inBurst
        if (inBurst && firstIndex >= 0) out.splice(firstIndex, 1)
      } else if (inBurst) {
        inBurst = gap >= 0 && gap <= 1000
        skip = inBurst
      }
    }
    if (!tuple || !tuple.some(Boolean) || skip) continue
    if (!underRoots(cwd, ctx.roots)) continue
    const key = `x:${session}:${r.timestamp}:${model}:${tuple.join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    if (inBurst === null) firstIndex = out.length
    out.push({
      key,
      tool: 'codex',
      seat: ctx.seat,
      session,
      ts,
      model,
      cwd,
      branch: null,
      // Codex counts cache reads inside input; report uncached input like ccusage does.
      input: Math.max(0, tuple[0]! - tuple[1]!),
      cacheRead: tuple[1]!,
      cacheWrite: tuple[2]!,
      output: tuple[3]!,
      side,
    })
  }
  return out
}

interface GrokCtx {
  seat: string
  session: string
  cwd: string
}

/**
 * Grok's updates.jsonl carries a cumulative usage object per model; the last one is the
 * session's total, and `costUsdTicks` is Grok's own cost in 1e-10 USD.
 */
export function parseGrokUpdates(text: string, ctx: GrokCtx): UsageEntry[] {
  let latest: { ts: number; modelUsage: Record<string, any> } | null = null
  const findUsage = (v: any, depth = 0): any => {
    if (!v || typeof v !== 'object' || depth > 6) return null
    if (v.usage && typeof v.usage === 'object' && v.usage.modelUsage) return v.usage
    for (const k of Object.keys(v)) {
      const hit = findUsage(v[k], depth + 1)
      if (hit) return hit
    }
    return null
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"modelUsage"')) continue
    let r: any
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const u = findUsage(r)
    if (!u) continue
    const raw = r.timestamp ?? r.ts
    const ts = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw)
    if (!Number.isFinite(ts)) continue
    latest = { ts, modelUsage: u.modelUsage }
  }
  if (!latest) return []
  return Object.entries(latest.modelUsage).map(([model, u]: [string, any]) => ({
    key: `g:${ctx.session}:${model}`,
    tool: 'grok' as const,
    seat: ctx.seat,
    session: ctx.session,
    ts: latest!.ts,
    model,
    cwd: ctx.cwd,
    branch: null,
    input: Math.max(0, n(u.inputTokens) - n(u.cachedReadTokens)),
    cacheRead: n(u.cachedReadTokens),
    cacheWrite: n(u.cacheCreationTokens),
    output: n(u.outputTokens),
    side: false,
    ...(typeof u.modelCalls === 'number' ? { calls: u.modelCalls } : {}),
    ...(typeof u.costUsdTicks === 'number' ? { cost: u.costUsdTicks / 1e10 } : {}),
  }))
}

export interface AntigravityRow {
  conversation_id: string
  step_count: number
  last_modified_time: string
  workspace_uris: string
  app_data_dir: string
}

/**
 * Antigravity keeps conversation summaries (workspace, steps, times) in SQLite but no token
 * counts, so each conversation becomes a zero-token entry that still carries sessions and
 * activity. Its cost stays unpriced rather than guessed.
 */
export function antigravityEntries(
  rows: AntigravityRow[],
  seat: string,
  roots: string[],
): UsageEntry[] {
  const out: UsageEntry[] = []
  for (const r of rows) {
    let uris: string[] = []
    try {
      uris = JSON.parse(r.workspace_uris || '[]')
    } catch {}
    const cwd = uris
      .map((u) => (u.startsWith('file://') ? decodeURIComponent(u.slice(7)) : u))
      .find((p) => underRoots(p, roots))
    if (!cwd) continue
    // SQLite's "YYYY-MM-DD HH:MM:SS" needs the T, or V8's legacy parser reads year 0001 as 2001.
    const ts = Date.parse(String(r.last_modified_time).replace(' ', 'T'))
    if (!Number.isFinite(ts) || ts < Date.UTC(2000, 0, 1)) continue
    out.push({
      key: `a:${r.conversation_id}`,
      tool: 'antigravity',
      seat,
      session: r.conversation_id,
      ts,
      model: 'antigravity',
      cwd,
      branch: null,
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      side: false,
      calls: Math.max(0, r.step_count | 0),
    })
  }
  return out
}

// --- store -----------------------------------------------------------------------------

const total = (e: UsageEntry) => e.input + e.output + e.cacheWrite + e.cacheRead

/** Entries keyed for idempotent re-reads, persisted as an append-only JSONL where the last line for a key wins. */
export class UsageStore {
  readonly entries = new Map<string, UsageEntry>()
  cursors: Record<string, { size: number; mtimeMs: number; offset: number; skip?: boolean }> = {}
  private appended = 0
  private tombstones: string[] = []
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(path.join(this.dir, 'usage.jsonl'), 'utf8')
      for (const line of raw.split('\n')) {
        if (!line) continue
        try {
          const e = JSON.parse(line) as UsageEntry & { deleted?: boolean }
          if (e.deleted) this.entries.delete(e.key)
          else this.entries.set(e.key, e)
        } catch {}
      }
      this.appended = raw.split('\n').length
    } catch {}
    try {
      const c = JSON.parse(await readFile(path.join(this.dir, 'scan.json'), 'utf8'))
      if (c.__v === CURSOR_VERSION) this.cursors = c
    } catch {}
  }

  /** Files the entry; a Claude re-stream with a larger total replaces the earlier copy. */
  upsert(e: UsageEntry): 'new' | 'updated' | 'same' {
    const prev = this.entries.get(e.key)
    if (!prev) {
      this.entries.set(e.key, e)
      return 'new'
    }
    const better = prev.side !== e.side ? prev.side : total(e) > total(prev)
    const rolled =
      (e.cost !== undefined && e.cost !== prev.cost) ||
      (e.calls !== undefined && e.calls !== prev.calls)
    if (!better && !rolled) return 'same'
    this.entries.set(e.key, e)
    return 'updated'
  }

  /** Drops an entry; the removal is persisted as a tombstone line. */
  remove(key: string): boolean {
    if (!this.entries.has(key)) return false
    this.entries.delete(key)
    this.tombstones.push(key)
    return true
  }

  async persist(changed: UsageEntry[]): Promise<void> {
    const tombstones = this.tombstones.splice(0)
    if (!changed.length && !tombstones.length) return
    await mkdir(this.dir, { recursive: true })
    const file = path.join(this.dir, 'usage.jsonl')
    if (this.appended > this.entries.size * 2 + 1000) {
      // Rewrite so superseded lines do not pile up.
      const tmp = file + '.tmp'
      await writeFile(tmp, [...this.entries.values()].map((e) => JSON.stringify(e) + '\n').join(''))
      await rename(tmp, file)
      this.appended = this.entries.size
      return
    }
    const lines = [
      ...changed.map((e) => JSON.stringify(e)),
      ...tombstones.map((key) => JSON.stringify({ key, deleted: true })),
    ]
    await appendFile(file, lines.map((l) => l + '\n').join(''))
    this.appended += lines.length
  }

  async saveCursors(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(
      path.join(this.dir, 'scan.json'),
      JSON.stringify({ ...this.cursors, __v: CURSOR_VERSION }),
    )
  }
}

// --- scanning ------------------------------------------------------------------------

export interface ScanResult {
  changed: UsageEntry[]
  files: number
  seats: string[]
}

async function walk(dir: string, suffix: string, depth = 6): Promise<string[]> {
  const out: string[] = []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const p = path.join(dir, name)
    let st
    try {
      st = await stat(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (depth > 0) out.push(...(await walk(p, suffix, depth - 1)))
    } else if (name.endsWith(suffix)) out.push(p)
  }
  return out
}

/** Lines appended since the cursor, plus the new offset; a torn last line waits for next time. */
async function readNewLines(
  file: string,
  offset: number,
  size: number,
): Promise<{ lines: string[]; offset: number }> {
  if (size <= offset) return { lines: [], offset }
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(size - offset)
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
    let text = buf.subarray(0, bytesRead).toString('utf8')
    const cut = text.lastIndexOf('\n')
    if (cut < 0) return { lines: [], offset }
    text = text.slice(0, cut)
    return { lines: text.split('\n'), offset: offset + Buffer.byteLength(text) + 1 }
  } finally {
    await fh.close()
  }
}

/** One pass over every source; incremental for Claude, whole-file-on-change for Codex and Grok. */
export async function scan(
  cfg: UsageConfig,
  store: UsageStore,
  sources: Source[],
): Promise<ScanResult> {
  const changed: UsageEntry[] = []
  const seats = new Set<string>()
  let files = 0
  const file = (e: UsageEntry) => {
    const r = store.upsert(e)
    if (r !== 'same') changed.push(e)
  }
  const prefixes = cfg.roots.map(claudeProjectDirName)

  for (const src of sources) {
    if (!cfg.sources[src.tool]) continue
    if (src.tool === 'claude') {
      let dirs: string[] = []
      try {
        dirs = (await readdir(src.dir)).filter((d) =>
          prefixes.some((p) => d === p || d.startsWith(p + '-')),
        )
      } catch {
        continue
      }
      for (const d of dirs) {
        // Subagent transcripts sit under <session>/subagents/, so walk a few levels.
        for (const f of await walk(path.join(src.dir, d), '.jsonl', 4)) {
          const st = await stat(f).catch(() => null)
          if (!st) continue
          const cur = store.cursors[f]
          // A rewritten or truncated file starts over.
          const offset = cur && cur.size <= st.size && cur.mtimeMs <= st.mtimeMs ? cur.offset : 0
          if (offset === st.size) continue
          const { lines, offset: next } = await readNewLines(f, offset, st.size)
          files++
          seats.add(src.seat)
          for (const e of parseClaudeLines(lines, {
            seat: src.seat,
            roots: cfg.roots,
            session: path.basename(f, '.jsonl'),
          }))
            file(e)
          store.cursors[f] = { size: st.size, mtimeMs: st.mtimeMs, offset: next }
        }
      }
    } else if (src.tool === 'codex') {
      for (const f of await walk(src.dir, '.jsonl', 4)) {
        const st = await stat(f).catch(() => null)
        if (!st) continue
        const cur = store.cursors[f]
        if (cur && cur.size === st.size && cur.mtimeMs === st.mtimeMs) continue
        if (cur?.skip && cur.size <= st.size) {
          store.cursors[f] = { ...cur, size: st.size, mtimeMs: st.mtimeMs }
          continue
        }
        // The session_meta line can run well past a few KB (workspace roots, config), so read
        // until its newline rather than a fixed head.
        const meta = await readFirstLine(f, 1 << 20)
        let cwd: string | undefined
        try {
          cwd = meta && meta.includes('"session_meta"') ? JSON.parse(meta).payload?.cwd : undefined
        } catch {}
        if (!underRoots(cwd, cfg.roots)) {
          store.cursors[f] = { size: st.size, mtimeMs: st.mtimeMs, offset: 0, skip: true }
          continue
        }
        files++
        seats.add(src.seat)
        for (const e of parseCodexFile(await readFile(f, 'utf8'), {
          seat: src.seat,
          roots: cfg.roots,
        }))
          file(e)
        store.cursors[f] = { size: st.size, mtimeMs: st.mtimeMs, offset: st.size }
      }
    } else if (src.tool === 'antigravity') {
      // The summaries DB says which conversations belong to the repo; each conversation's own
      // DB (plus its WAL, which is where fresh writes land) carries the token usage.
      const summariesDb = path.join(src.dir, 'conversation_summaries.db')
      let rows: AntigravityRow[] = []
      try {
        const { DatabaseSync } = await import('node:sqlite')
        const db = new DatabaseSync(summariesDb, { readOnly: true })
        try {
          rows = db
            .prepare(
              'select conversation_id, step_count, last_modified_time, workspace_uris, app_data_dir from conversation_summaries',
            )
            .all() as unknown as AntigravityRow[]
        } finally {
          db.close()
        }
      } catch (err) {
        console.error(
          'repo-pulse: antigravity read failed',
          err instanceof Error ? err.message : err,
        )
        continue
      }
      for (const summary of antigravityEntries(rows, src.seat, cfg.roots)) {
        const f = path.join(src.dir, 'conversations', `${summary.session}.db`)
        const st = await stat(f).catch(() => null)
        if (!st) {
          file(summary)
          continue
        }
        const wal = await stat(`${f}-wal`).catch(() => null)
        const size = st.size + (wal?.size ?? 0)
        const mtimeMs = Math.max(st.mtimeMs, wal?.mtimeMs ?? 0)
        const cur = store.cursors[f]
        if (cur && cur.size === size && cur.mtimeMs === mtimeMs) continue
        files++
        seats.add(src.seat)
        let events
        try {
          events = conversationEvents(await readConversation(f, mtimeMs))
        } catch (err) {
          console.error(
            'repo-pulse: antigravity conversation read failed',
            f,
            err instanceof Error ? err.message : err,
          )
          file(summary)
          continue
        }
        if (!events.length) file(summary)
        else if (store.remove(summary.key)) changed.push(summary)
        events.forEach((ev, i) => {
          file({
            key: `a:${summary.session}:${ev.identities[0] ?? `#${i}`}`,
            tool: 'antigravity',
            seat: src.seat,
            session: summary.session,
            ts: ev.ts,
            model: ev.model,
            cwd: summary.cwd,
            branch: null,
            input: ev.input,
            output: ev.output,
            cacheWrite: ev.cacheWrite,
            cacheRead: ev.cacheRead,
            side: false,
          })
        })
        store.cursors[f] = { size, mtimeMs, offset: size }
      }
    } else if (src.tool === 'grok') {
      let dirs: string[] = []
      try {
        dirs = await readdir(src.dir)
      } catch {
        continue
      }
      for (const enc of dirs) {
        let cwd: string
        try {
          cwd = decodeURIComponent(enc)
        } catch {
          continue
        }
        if (!underRoots(cwd, cfg.roots)) continue
        let sessions: string[] = []
        try {
          sessions = await readdir(path.join(src.dir, enc))
        } catch {
          continue
        }
        for (const sid of sessions) {
          const f = path.join(src.dir, enc, sid, 'updates.jsonl')
          const st = await stat(f).catch(() => null)
          if (!st) continue
          const cur = store.cursors[f]
          if (cur && cur.size === st.size && cur.mtimeMs === st.mtimeMs) continue
          files++
          seats.add(src.seat)
          for (const e of parseGrokUpdates(await readFile(f, 'utf8'), {
            seat: src.seat,
            session: sid,
            cwd,
          }))
            file(e)
          store.cursors[f] = { size: st.size, mtimeMs: st.mtimeMs, offset: st.size }
        }
      }
    }
  }
  await store.persist(changed)
  await store.saveCursors()
  return { changed, files, seats: [...seats] }
}

/** The first line of a file, reading in 16 KB steps up to `max` bytes. */
async function readFirstLine(file: string, max: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total < max) {
      const buf = Buffer.alloc(16384)
      const { bytesRead } = await fh.read(buf, 0, buf.length, total)
      if (bytesRead === 0) break
      const part = buf.subarray(0, bytesRead)
      const nl = part.indexOf(10)
      if (nl >= 0) {
        chunks.push(part.subarray(0, nl))
        return Buffer.concat(chunks).toString('utf8')
      }
      chunks.push(part)
      total += bytesRead
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await fh.close()
  }
}
