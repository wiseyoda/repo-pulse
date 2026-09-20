// API-equivalent pricing from LiteLLM's public price file, cached under ~/.repo-usage, with a
// manual override file for models it lacks. Costs are what the same tokens would have cost on
// the provider's API; subscriptions are not modelled here.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { UsageEntry } from './usage.ts'

export interface Price {
  /** USD per token. */
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export type PriceTable = Record<string, Price>

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const TTL_MS = 24 * 3600_000
const PROVIDER_PREFIX = /^(?:[a-z_]+\/)+|^(?:[a-z-]+\.)+(?=[a-z])/i

/** Keep chat models with an input price; drop provider-prefixed duplicates when a plain key exists. */
export function extractPrices(doc: Record<string, any>): PriceTable {
  const out: PriceTable = {}
  for (const [key, m] of Object.entries(doc)) {
    if (!m || typeof m !== 'object') continue
    if (m.mode && m.mode !== 'chat' && m.mode !== 'responses' && m.mode !== 'completion') continue
    const input = m.input_cost_per_token
    const output = m.output_cost_per_token
    if (typeof input !== 'number' || typeof output !== 'number') continue
    out[key] = {
      input,
      output,
      cacheWrite:
        typeof m.cache_creation_input_token_cost === 'number'
          ? m.cache_creation_input_token_cost
          : input,
      cacheRead:
        typeof m.cache_read_input_token_cost === 'number' ? m.cache_read_input_token_cost : input,
    }
  }
  return out
}

const normalize = (s: string) => s.trim().toLowerCase()

export class PriceBook {
  private readonly table: PriceTable
  private readonly plain = new Map<string, string>() // provider-stripped key -> full key
  private readonly cache = new Map<string, { key: string; price: Price } | null>()
  readonly fetchedAt: number

  constructor(table: PriceTable, fetchedAt = 0) {
    this.table = table
    this.fetchedAt = fetchedAt
    for (const key of Object.keys(table)) {
      const bare = normalize(key).replace(PROVIDER_PREFIX, '')
      // A plain key beats a prefixed one for the same bare name.
      if (!this.plain.has(bare) || !key.includes('/')) this.plain.set(bare, key)
    }
  }

  get size(): number {
    return Object.keys(this.table).length
  }

  /**
   * Exact, then provider-stripped, then progressively shorter dash-separated prefixes
   * ("grok-4.6-build" → "grok-4.6"), then a dated variant of the same name.
   */
  find(model: string): { key: string; price: Price } | null {
    const hit = this.cache.get(model)
    if (hit !== undefined) return hit
    const found = this.lookup(model)
    this.cache.set(model, found)
    return found
  }

  private lookup(model: string): { key: string; price: Price } | null {
    const m = normalize(model)
    if (this.table[model]) return { key: model, price: this.table[model]! }
    const candidates = [m, m.replace(PROVIDER_PREFIX, '')]
    for (const c of candidates) {
      const key = this.plain.get(c)
      if (key) return { key, price: this.table[key]! }
    }
    const bare = candidates[1]!
    const parts = bare.split('-')
    for (let i = parts.length - 1; i >= 2; i--) {
      const key = this.plain.get(parts.slice(0, i).join('-'))
      if (key) return { key, price: this.table[key]! }
    }
    // "claude-x-1" may only exist as "claude-x-1-20260101": longest plain key sharing the prefix.
    let best: string | null = null
    for (const [plainKey, key] of this.plain) {
      if (plainKey.startsWith(bare + '-') && /^\d{8}$/.test(plainKey.slice(bare.length + 1)))
        if (!best || key.length < best.length) best = key
    }
    return best ? { key: best, price: this.table[best]! } : null
  }

  /** USD for one entry; the tool's own figure wins when it reported one. Null when unpriced. */
  cost(e: UsageEntry): number | null {
    if (typeof e.cost === 'number') return e.cost
    const p = this.find(e.model)?.price
    if (!p) return null
    return (
      e.input * p.input +
      e.output * p.output +
      e.cacheWrite * p.cacheWrite +
      e.cacheRead * p.cacheRead
    )
  }
}

interface Overrides {
  models?: Record<
    string,
    { input: number; output: number; cacheWrite?: number; cacheRead?: number }
  >
}

/** Cached price file (refreshed daily when online) merged with ~/.repo-usage/pricing_overrides.json (USD per million tokens). */
export async function loadPrices(
  home: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ book: PriceBook; source: string }> {
  const cacheFile = path.join(home, 'prices.json')
  let table: PriceTable | null = null
  let fetchedAt = 0
  let source = 'none'
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as {
      fetchedAt: number
      table: PriceTable
    }
    table = cached.table
    fetchedAt = cached.fetchedAt
    source = 'cache'
  } catch {}
  if (!table || now - fetchedAt > TTL_MS) {
    try {
      const res = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(20_000) })
      if (res.ok) {
        table = extractPrices((await res.json()) as Record<string, any>)
        fetchedAt = now
        source = 'litellm'
        await mkdir(home, { recursive: true })
        await writeFile(cacheFile, JSON.stringify({ fetchedAt, table }))
      }
    } catch {
      // Offline: the cache, however old, still prices the past.
    }
  }
  table ??= {}
  try {
    const ov = JSON.parse(
      await readFile(path.join(home, 'pricing_overrides.json'), 'utf8'),
    ) as Overrides
    for (const [model, p] of Object.entries(ov.models ?? {})) {
      table[model] = {
        input: p.input / 1e6,
        output: p.output / 1e6,
        cacheWrite: (p.cacheWrite ?? p.input) / 1e6,
        cacheRead: (p.cacheRead ?? p.input) / 1e6,
      }
    }
  } catch {}
  return { book: new PriceBook(table, fetchedAt), source }
}
