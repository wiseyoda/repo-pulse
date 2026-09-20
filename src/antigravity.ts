// Antigravity keeps each conversation in its own SQLite file with protobuf blobs; token usage
// lives in the generator metadata and step metadata. This ports ccusage's adapter for it,
// field numbers and all, so the numbers agree with ccusage. Pure functions take blobs and
// rows; only `readConversation` touches SQLite.

export interface ModelUsage {
  modelId: number | null
  input: number
  totalOutput: number
  cacheWrite: number
  cacheRead: number
  reasoning: number
  visibleOutput: number
  provider: number | null
  messageId: string | null
  responseId: string | null
  providerMessageId: string | null
}

export interface UsageEvent {
  ts: number
  tsRank: number
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  reasoning: number
  identities: string[]
}

const DEFAULT_MODEL = 'gemini-internal-model'

// --- protobuf wire decoding -----------------------------------------------------------

type Field = { n: number; wire: number; v: number | Uint8Array }

export function decodeFields(buf: Uint8Array): Field[] {
  const out: Field[] = []
  let i = 0
  const varint = (): number => {
    let value = 0
    let mult = 1
    for (let k = 0; k < 10; k++) {
      if (i >= buf.length) throw new Error('truncated varint')
      const b = buf[i++]!
      value += (b & 0x7f) * mult
      if ((b & 0x80) === 0) return value
      mult *= 128
    }
    throw new Error('varint overflow')
  }
  while (i < buf.length) {
    const tag = varint()
    const n = Math.floor(tag / 8)
    const wire = tag % 8
    if (n === 0) throw new Error('field number zero')
    if (wire === 0) out.push({ n, wire, v: varint() })
    else if (wire === 1) {
      i += 8
      out.push({ n, wire, v: 0 })
    } else if (wire === 5) {
      i += 4
      out.push({ n, wire, v: 0 })
    } else if (wire === 2) {
      const len = varint()
      if (i + len > buf.length) throw new Error('truncated bytes')
      out.push({ n, wire, v: buf.subarray(i, i + len) })
      i += len
    } else throw new Error(`unsupported wire type ${wire}`)
  }
  return out
}

const lastVarint = (f: Field[], n: number): number | null => {
  for (let i = f.length - 1; i >= 0; i--)
    if (f[i]!.n === n && f[i]!.wire === 0) return f[i]!.v as number
  return null
}
const firstBytes = (f: Field[], n: number): Uint8Array | null =>
  (f.find((x) => x.n === n && x.wire === 2)?.v as Uint8Array | undefined) ?? null
const allBytes = (f: Field[], n: number): Uint8Array[] =>
  f.filter((x) => x.n === n && x.wire === 2).map((x) => x.v as Uint8Array)
const lastText = (f: Field[], n: number): string | null => {
  for (let i = f.length - 1; i >= 0; i--) {
    const x = f[i]!
    if (x.n === n && x.wire === 2) {
      try {
        const s = new TextDecoder('utf-8', { fatal: true }).decode(x.v as Uint8Array)
        if (s.trim()) return s
      } catch {}
    }
  }
  return null
}

function parseTimestamp(blob: Uint8Array | null): number | null {
  if (!blob) return null
  const f = decodeFields(blob)
  const seconds = lastVarint(f, 1)
  if (!seconds || seconds <= 0) return null
  const nanos = Math.min(lastVarint(f, 2) ?? 0, 999_999_999)
  return seconds * 1000 + Math.floor(nanos / 1_000_000)
}

export function parseModelUsage(blob: Uint8Array): ModelUsage {
  const f = decodeFields(blob)
  const id = lastVarint(f, 1)
  const prov = lastVarint(f, 6)
  return {
    modelId: id ? id : null,
    input: lastVarint(f, 2) ?? 0,
    totalOutput: lastVarint(f, 3) ?? 0,
    cacheWrite: lastVarint(f, 4) ?? 0,
    cacheRead: lastVarint(f, 5) ?? 0,
    reasoning: lastVarint(f, 9) ?? 0,
    visibleOutput: lastVarint(f, 10) ?? 0,
    provider: prov ? prov : null,
    messageId: lastText(f, 7),
    responseId: lastText(f, 11),
    providerMessageId: lastText(f, 12),
  }
}

const parseRetries = (blobs: Uint8Array[]): ModelUsage[] =>
  blobs.flatMap((b) => {
    const u = firstBytes(decodeFields(b), 2)
    return u ? [parseModelUsage(u)] : []
  })

export interface GeneratorMetadata {
  model: string | null
  modelId: number | null
  usage: ModelUsage | null
  retries: ModelUsage[]
  ts: number | null
}

export function parseGeneratorMetadata(blob: Uint8Array): GeneratorMetadata {
  const root = decodeFields(blob)
  const chat = firstBytes(root, 1)
  if (!chat) throw new Error('missing chat model field 1')
  const f = decodeFields(chat)
  const usage = firstBytes(f, 4)
  const gen = firstBytes(f, 9)
  const id = lastVarint(f, 3)
  return {
    model: lastText(f, 19) ?? lastText(f, 21),
    modelId: id ? id : null,
    usage: usage ? parseModelUsage(usage) : null,
    retries: parseRetries(allBytes(f, 17)),
    ts: gen ? parseTimestamp(firstBytes(decodeFields(gen), 4)) : null,
  }
}

export interface StepMetadata extends GeneratorMetadata {
  provider: number | null
}

export function parseStepMetadata(blob: Uint8Array): StepMetadata {
  const f = decodeFields(blob)
  const usage = firstBytes(f, 9)
  const info = firstBytes(f, 24)
  let model: string | null = null
  let modelId: number | null = null
  let provider: number | null = null
  if (info) {
    const m = decodeFields(info)
    model = lastText(m, 12) ?? lastText(m, 8)
    modelId = lastVarint(m, 1) || null
    provider = lastVarint(m, 7) || null
  }
  return {
    model,
    modelId,
    provider,
    usage: usage ? parseModelUsage(usage) : null,
    retries: parseRetries(allBytes(f, 28)),
    ts: parseTimestamp(firstBytes(f, 8) ?? firstBytes(f, 1)),
  }
}

export function parseTrajectoryTimestamp(blob: Uint8Array): number | null {
  return parseTimestamp(firstBytes(decodeFields(blob), 2))
}

// --- model names ---------------------------------------------------------------------------

const MODEL_IDS: Record<number, string> = {
  246: 'gemini-2.5-pro',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  281: 'claude-4-sonnet',
  282: 'claude-4-sonnet',
  290: 'claude-4-opus',
  291: 'claude-4-opus',
  333: 'claude-4.5-sonnet',
  334: 'claude-4.5-sonnet',
  340: 'claude-4.5-haiku',
  341: 'claude-4.5-haiku',
  342: 'model_openai_gpt_oss_120b_medium',
  1318: 'gemini-3.8-flash-high',
  1319: 'gemini-3.8-flash-medium',
  1320: 'gemini-3.8-flash-low',
  1298: 'gemini-3.7-flash-high',
  1299: 'gemini-3.7-flash-medium',
  1300: 'gemini-3.7-flash-low',
  1071: 'gemini-3.6-flash-high',
  1072: 'gemini-3.6-flash-medium',
  1073: 'gemini-3.6-flash-low',
}

export function modelNameFromId(id: number): string {
  return (
    MODEL_IDS[id] ?? (id >= 1000 ? `model_placeholder_m${id - 1000}` : `antigravity-model-${id}`)
  )
}

const EFFORT: Record<string, string> = {
  'gemini 3.8 flash (high)': 'gemini-3.8-flash-high',
  'gemini 3.8 flash (medium)': 'gemini-3.8-flash-medium',
  'gemini 3.8 flash (low)': 'gemini-3.8-flash-low',
  'gemini 3.7 flash (high)': 'gemini-3.7-flash-high',
  'gemini 3.7 flash (medium)': 'gemini-3.7-flash-medium',
  'gemini 3.7 flash (low)': 'gemini-3.7-flash-low',
  'gemini 3.6 flash (high)': 'gemini-3.6-flash-high',
  'gemini 3.6 flash (medium)': 'gemini-3.6-flash-medium',
  'gemini 3.6 flash (low)': 'gemini-3.6-flash-low',
}

const BASE: Record<string, string> = {
  'gemini 3.8 flash': 'gemini-3.8-flash',
  'gemini 3.8 flash thinking': 'gemini-3.8-flash',
  'gemini 3.7 flash': 'gemini-3.7-flash',
  'gemini 3.7 flash thinking': 'gemini-3.7-flash',
  'gemini 3.7 pro': 'gemini-3.7-pro',
  'gemini 3.7 pro thinking': 'gemini-3.7-pro',
  'gemini 3.6 flash': 'gemini-3.6-flash',
  'gemini 3 flash': 'gemini-3.6-flash',
  'gemini 3.6 pro': 'gemini-3.6-pro',
  'gemini 3 pro': 'gemini-3-pro',
  'gemini 3 pro thinking': 'gemini-3-pro',
  'gemini 2.5 flash': 'gemini-2.5-flash',
  'gemini 2.5 pro': 'gemini-2.5-pro',
  'gemini 2.0 flash': 'gemini-2.0-flash',
  'gemini 2 flash': 'gemini-2.0-flash',
  'gemini 2.0 pro': 'gemini-2.0-pro',
  'gemini 1.5 flash': 'gemini-1.5-flash',
  'gemini 1.5 pro': 'gemini-1.5-pro',
  model_placeholder_m318: 'gemini-3.8-flash-high',
  model_placeholder_m319: 'gemini-3.8-flash-medium',
  model_placeholder_m320: 'gemini-3.8-flash-low',
  model_placeholder_m298: 'gemini-3.7-flash-high',
  model_placeholder_m299: 'gemini-3.7-flash-medium',
  model_placeholder_m300: 'gemini-3.7-flash-low',
  model_placeholder_m71: 'gemini-3.6-flash-high',
  model_placeholder_m72: 'gemini-3.6-flash-medium',
  model_placeholder_m73: 'gemini-3.6-flash-low',
  model_placeholder_m26: 'claude-opus-4-6',
  model_placeholder_m35: 'claude-sonnet-4-6',
  model_placeholder_m36: 'gemini-3.1-pro',
  model_placeholder_m37: 'gemini-3.1-pro',
  model_placeholder_m16: 'gemini-3.1-pro',
  model_placeholder_m18: 'gemini-3-flash-preview',
  model_placeholder_m84: 'gemini-3-flash-preview',
  model_placeholder_m47: 'gemini-3-flash-preview',
  model_placeholder_m132: 'gemini-3.5-flash-high',
  model_placeholder_m133: 'gemini-3.5-flash-high',
  model_placeholder_m187: 'gemini-3.5-flash-extra-low',
  model_placeholder_m20: 'gemini-3.5-flash-medium',
  model_openai_gpt_oss_120b_medium: 'gpt-oss-120b-medium',
  'gemini-pro-default': 'gemini-3.1-pro',
  'gemini-pro-agent': 'gemini-3.1-pro',
  'gemini-3-flash-agent': 'gemini-3.5-flash-high',
  'gemini-3-flash-agent-a': 'gemini-3.5-flash-high',
  'gemini-3-flash-agent-b': 'gemini-3.5-flash-high',
  'gemini-3-flash-a': 'gemini-3.5-flash-high',
  'gemini-3-flash-b': 'gemini-3.5-flash-high',
  'gemini-3-flash-c': 'gemini-3-flash-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-medium',
  'gemini-3.1-pro-high': 'gemini-3.1-pro',
  'gemini-3.1-pro-low': 'gemini-3.1-pro',
  'gemini-3-pro-high': 'gemini-3-pro',
  'gemini-3-pro-low': 'gemini-3-pro',
  'claude 3.7 sonnet': 'claude-3-7-sonnet',
  'claude 3.7 sonnet thinking': 'claude-3-7-sonnet',
  'claude 3.5 sonnet': 'claude-3-5-sonnet',
  'claude 3.5 haiku': 'claude-3-5-haiku',
  'claude 3 opus': 'claude-3-opus',
}

export function normalizeModel(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (EFFORT[lower]) return EFFORT[lower]!
  const paren = lower.indexOf('(')
  const base = paren >= 0 ? lower.slice(0, paren).trim() : lower
  if (BASE[base]) return BASE[base]!
  const converted = base.replace(/ /g, '-')
  if (/^(gemini|claude|gpt)-/.test(converted)) return converted
  return trimmed
}

// --- events ------------------------------------------------------------------------------

const tokenBearing = (u: ModelUsage) =>
  u.input > 0 ||
  u.totalOutput > 0 ||
  u.cacheWrite > 0 ||
  u.cacheRead > 0 ||
  u.reasoning > 0 ||
  u.visibleOutput > 0

const identities = (u: ModelUsage): string[] =>
  [
    u.responseId && `response:${u.responseId}`,
    u.providerMessageId && `provider:${u.providerMessageId}`,
    u.messageId && `message:${u.messageId}`,
  ].filter((x): x is string => Boolean(x))

interface Ctx {
  model: string | null
  ts: [number, number] | null
  trajectoryTs: number | null
  fallbackTs: number
}

/** ccusage's append_usage_event: fills output buckets, resolves the timestamp by rank, names the model. */
function appendEvent(
  events: UsageEvent[],
  idTs: Map<string, [number, number]>,
  u: ModelUsage,
  ctx: Ctx,
): void {
  if (!tokenBearing(u)) return
  const ids = identities(u)
  const fromId = ids.map((k) => idTs.get(k)).find(Boolean)
  const [ts, rank]: [number, number] =
    ctx.ts ?? fromId ?? (ctx.trajectoryTs ? [ctx.trajectoryTs, 1] : [ctx.fallbackTs, 0])
  const totalOutput = Math.max(u.totalOutput, u.visibleOutput + u.reasoning)
  const output = Math.max(u.visibleOutput, totalOutput - u.reasoning)
  const reasoning = Math.max(u.reasoning, totalOutput - output)
  const model =
    (u.modelId && normalizeModel(modelNameFromId(u.modelId))) ||
    normalizeModel(ctx.model) ||
    DEFAULT_MODEL
  for (const k of ids) {
    const old = idTs.get(k)
    if (!old || rank > old[1] || (rank === old[1] && ts < old[0])) idTs.set(k, [ts, rank])
  }
  events.push({
    ts,
    tsRank: rank,
    model,
    input: u.input,
    output: totalOutput,
    cacheWrite: u.cacheWrite,
    cacheRead: u.cacheRead,
    reasoning,
    identities: ids,
  })
}

export interface ConversationRows {
  generations: Uint8Array[]
  steps: Uint8Array[]
  trajectory: Uint8Array | null
  fallbackTs: number
}

/** Every token-bearing event in one conversation, in ccusage's order (steps, then generations). */
export function conversationEvents(rows: ConversationRows): UsageEvent[] {
  const gens = rows.generations.map(parseGeneratorMetadata)
  const steps = rows.steps.map(parseStepMetadata)
  const trajectoryTs = rows.trajectory ? parseTrajectoryTimestamp(rows.trajectory) : null
  const nameOf = (m: GeneratorMetadata) =>
    normalizeModel(m.model) ?? (m.modelId ? normalizeModel(modelNameFromId(m.modelId)) : null)
  let generationModel: string | null = null
  for (let i = gens.length - 1; i >= 0 && !generationModel; i--) generationModel = nameOf(gens[i]!)
  const events: UsageEvent[] = []
  const idTs = new Map<string, [number, number]>()
  for (const s of steps) {
    const model = nameOf(s) ?? generationModel
    const ctx: Ctx = {
      model,
      ts: s.ts ? [s.ts, 3] : null,
      trajectoryTs,
      fallbackTs: rows.fallbackTs,
    }
    if (s.usage) appendEvent(events, idTs, s.usage, ctx)
    for (const r of s.retries) appendEvent(events, idTs, r, ctx)
  }
  let current: string | null = null
  for (const g of gens) {
    const rowModel =
      nameOf(g) ?? (g.usage?.modelId ? normalizeModel(modelNameFromId(g.usage.modelId)) : null)
    if (rowModel) current = rowModel
    const ctx: Ctx = {
      model: current,
      ts: g.ts ? [g.ts, 3] : null,
      trajectoryTs,
      fallbackTs: rows.fallbackTs,
    }
    if (g.usage) appendEvent(events, idTs, g.usage, ctx)
    for (const r of g.retries) appendEvent(events, idTs, r, ctx)
  }
  return dedupe(events)
}

/** Events sharing any identity merge into one, keeping the max of each bucket (ccusage's rule). */
export function dedupe(events: UsageEvent[]): UsageEvent[] {
  const out: UsageEvent[] = []
  const index = new Map<string, number>()
  for (const e of events) {
    const hits = [
      ...new Set(e.identities.map((k) => index.get(k)).filter((x): x is number => x !== undefined)),
    ]
    if (!hits.length) {
      out.push({ ...e, identities: [...e.identities] })
      for (const k of e.identities) index.set(k, out.length - 1)
      continue
    }
    const target = out[hits[0]!]!
    merge(target, e)
    for (let i = 1; i < hits.length; i++) {
      const other = out[hits[i]!]!
      merge(target, other)
      other.identities = []
      other.input = other.output = other.cacheWrite = other.cacheRead = other.reasoning = 0
    }
    for (const k of target.identities) index.set(k, hits[0]!)
  }
  return out.filter((e) => e.input + e.output + e.cacheWrite + e.cacheRead + e.reasoning > 0)
}

function merge(t: UsageEvent, d: UsageEvent): void {
  t.input = Math.max(t.input, d.input)
  t.cacheWrite = Math.max(t.cacheWrite, d.cacheWrite)
  t.cacheRead = Math.max(t.cacheRead, d.cacheRead)
  t.reasoning = Math.max(t.reasoning, d.reasoning)
  t.output = Math.max(t.output, d.output)
  if (t.model === DEFAULT_MODEL && d.model !== DEFAULT_MODEL) t.model = d.model
  if (d.tsRank > t.tsRank || (d.tsRank === t.tsRank && d.ts < t.ts)) {
    t.ts = d.ts
    t.tsRank = d.tsRank
  }
  for (const k of d.identities) if (!t.identities.includes(k)) t.identities.push(k)
}

/** Reads one conversation database read-only. Throws when SQLite is unavailable. */
export async function readConversation(
  file: string,
  fallbackTs: number,
): Promise<ConversationRows> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = new Set(
      (
        db.prepare("select name from sqlite_master where type = 'table'").all() as {
          name: string
        }[]
      ).map((r) => r.name),
    )
    if (!tables.has('gen_metadata'))
      return { generations: [], steps: [], trajectory: null, fallbackTs }
    const generations = (
      db.prepare('select data from gen_metadata order by idx asc').all() as { data: Uint8Array }[]
    ).map((r) => r.data)
    const steps = tables.has('steps')
      ? (
          db
            .prepare('select metadata from steps where metadata is not null order by idx asc')
            .all() as { metadata: Uint8Array }[]
        ).map((r) => r.metadata)
      : []
    const trajectory = tables.has('trajectory_metadata_blob')
      ? ((
          db
            .prepare('select data from trajectory_metadata_blob order by rowid asc limit 1')
            .get() as { data: Uint8Array } | undefined
        )?.data ?? null)
      : null
    return { generations, steps, trajectory, fallbackTs }
  } finally {
    db.close()
  }
}
