import { describe, expect, it } from 'vitest'
import {
  conversationEvents,
  decodeFields,
  dedupe,
  modelNameFromId,
  normalizeModel,
  parseGeneratorMetadata,
  parseModelUsage,
  parseStepMetadata,
} from '../src/antigravity.ts'

// A minimal protobuf encoder for fixtures: varints and length-delimited fields only.
const varint = (n: number): number[] => {
  const out: number[] = []
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b |= 0x80
    out.push(b)
  } while (n > 0)
  return out
}
const v = (field: number, n: number) => [...varint(field * 8), ...varint(n)]
const b = (field: number, bytes: number[] | Uint8Array | string) => {
  const arr = typeof bytes === 'string' ? [...new TextEncoder().encode(bytes)] : [...bytes]
  return [...varint(field * 8 + 2), ...varint(arr.length), ...arr]
}
const msg = (...parts: number[][]) => new Uint8Array(parts.flat())
const ts = (seconds: number) => msg(v(1, seconds), v(2, 500_000_000))

const usage = (
  over: Partial<Record<'id' | 'input' | 'total' | 'cw' | 'cr' | 'reason' | 'visible', number>> & {
    mid?: string
    rid?: string
  } = {},
) =>
  msg(
    v(1, over.id ?? 1318),
    v(2, over.input ?? 1000),
    v(3, over.total ?? 300),
    v(4, over.cw ?? 0),
    v(5, over.cr ?? 5000),
    v(9, over.reason ?? 100),
    v(10, over.visible ?? 200),
    ...(over.mid ? [b(7, over.mid)] : []),
    ...(over.rid ? [b(11, over.rid)] : []),
  )

describe('protobuf decoding', () => {
  it('reads varints and length-delimited fields with multi-byte lengths', () => {
    const f = decodeFields(msg(v(1, 300), b(2, 'x'.repeat(200))))
    expect(f[0]).toMatchObject({ n: 1, wire: 0, v: 300 })
    expect((f[1]?.v as Uint8Array).length).toBe(200)
  })
  it('parses a model usage message by ccusage field numbers', () => {
    expect(parseModelUsage(usage({ mid: 'm1', rid: 'r1' }))).toMatchObject({
      modelId: 1318,
      input: 1000,
      totalOutput: 300,
      cacheRead: 5000,
      reasoning: 100,
      visibleOutput: 200,
      messageId: 'm1',
      responseId: 'r1',
    })
  })
})

describe('model naming', () => {
  it('maps ids and normalizes display names like ccusage', () => {
    expect(modelNameFromId(1318)).toBe('gemini-3.8-flash-high')
    expect(modelNameFromId(1299)).toBe('gemini-3.7-flash-medium')
    expect(modelNameFromId(1500)).toBe('model_placeholder_m500')
    expect(normalizeModel('Gemini 3.7 Flash (Medium)')).toBe('gemini-3.7-flash-medium')
    expect(normalizeModel('Gemini 3 Pro Thinking')).toBe('gemini-3-pro')
    expect(normalizeModel('model_placeholder_m26')).toBe('claude-opus-4-6')
    expect(normalizeModel('Claude 9 Turbo')).toBe('claude-9-turbo')
    expect(normalizeModel('  ')).toBeNull()
  })
})

describe('conversationEvents', () => {
  const gen = (u: Uint8Array, seconds: number, retries: Uint8Array[] = []) =>
    msg(
      b(
        1,
        msg(
          v(3, 1318),
          b(4, u),
          b(9, msg(b(4, ts(seconds)))),
          ...retries.map((r) => b(17, msg(b(2, r)))),
        ),
      ),
    )
  const step = (u: Uint8Array, seconds: number) =>
    msg(b(9, u), b(8, ts(seconds)), b(24, msg(v(1, 1318))))

  it('parses generator and step rows and takes their timestamps', () => {
    const g = parseGeneratorMetadata(gen(usage(), 1_700_000_000))
    expect(g.modelId).toBe(1318)
    expect(g.usage?.input).toBe(1000)
    expect(g.ts).toBe(1_700_000_000_500)
    const s = parseStepMetadata(step(usage(), 1_700_000_100))
    expect(s.modelId).toBe(1318)
    expect(s.ts).toBe(1_700_000_100_500)
  })

  it('merges the step copy and the generation copy of the same response, keeping the max', () => {
    const rows = {
      generations: [gen(usage({ rid: 'resp-1', visible: 250, total: 350 }), 1_700_000_000)],
      steps: [step(usage({ rid: 'resp-1' }), 1_700_000_010)],
      trajectory: null,
      fallbackTs: 0,
    }
    const ev = conversationEvents(rows)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({
      model: 'gemini-3.8-flash-high',
      input: 1000,
      output: 350,
      cacheRead: 5000,
    })
    // Both copies carry rank-3 timestamps; the earlier one wins.
    expect(ev[0]?.ts).toBe(1_700_000_000_500)
  })

  it('counts retries and events without identities separately', () => {
    const rows = {
      generations: [gen(usage({ input: 10 }), 1_700_000_000, [usage({ input: 20 })])],
      steps: [],
      trajectory: null,
      fallbackTs: 0,
    }
    const ev = conversationEvents(rows)
    expect(ev.map((e) => e.input).sort()).toEqual([10, 20])
  })

  it('fills output buckets: total output covers visible plus reasoning', () => {
    const ev = conversationEvents({
      generations: [gen(usage({ total: 0, visible: 200, reason: 100 }), 1_700_000_000)],
      steps: [],
      trajectory: null,
      fallbackTs: 0,
    })
    expect(ev[0]).toMatchObject({ output: 300, reasoning: 100 })
  })

  it('dedupe keeps identities linked across three copies', () => {
    const e = (ids: string[], input: number) => ({
      ts: 1,
      tsRank: 0,
      model: 'm',
      input,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      reasoning: 0,
      identities: ids,
    })
    const out = dedupe([e(['a'], 1), e(['b'], 2), e(['a', 'b'], 3)])
    expect(out).toHaveLength(1)
    expect(out[0]?.input).toBe(3)
    expect(out[0]?.identities.sort()).toEqual(['a', 'b'])
  })
})
