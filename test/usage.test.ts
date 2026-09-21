import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractPrices, PriceBook } from '../src/prices.ts'
import {
  claudeProjectDirName,
  parseClaudeLines,
  parseCodexFile,
  parseGrokUpdates,
  repoNameFromRemote,
  underRoots,
  UsageStore,
  type UsageEntry,
} from '../src/usage.ts'

const ROOT = '/Users/me/dev/app'
const claudeLine = (over: Record<string, unknown>, usage: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    cwd: ROOT,
    gitBranch: 'main',
    timestamp: '2026-09-20T05:00:00.000Z',
    requestId: 'req_1',
    isSidechain: false,
    message: { id: 'msg_1', model: 'claude-fable-5-1', usage },
    ...over,
  })

describe('repo naming and matching', () => {
  it('takes the repo name from ssh and https remotes', () => {
    expect(repoNameFromRemote('git@github.com:wiseyoda/repo-pulse.git')).toBe('repo-pulse')
    expect(repoNameFromRemote('https://github.com/wiseyoda/repo-pulse')).toBe('repo-pulse')
    expect(repoNameFromRemote('https://github.com/wiseyoda/repo-pulse.git/')).toBe('repo-pulse')
  })
  it('matches cwds under a root but not siblings with the same prefix', () => {
    expect(underRoots(ROOT, [ROOT])).toBe(true)
    expect(underRoots(`${ROOT}/src`, [ROOT])).toBe(true)
    expect(underRoots(`${ROOT}-old`, [ROOT])).toBe(false)
  })
  it('encodes a cwd the way Claude Code names project dirs', () => {
    expect(claudeProjectDirName('/Users/me/dev/repo-pulse')).toBe('-Users-me-dev-repo-pulse')
  })
})

describe('parseClaudeLines', () => {
  it('reads usage, branch, and model from assistant records inside the roots only', () => {
    const lines = [
      JSON.stringify({ type: 'user', cwd: ROOT, timestamp: '2026-09-20T04:59:00.000Z' }),
      claudeLine(
        {},
        {
          input_tokens: 2,
          output_tokens: 50,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 900,
        },
      ),
      claudeLine(
        {
          cwd: '/elsewhere',
          message: { id: 'msg_2', model: 'claude-fable-5-1', usage: { input_tokens: 5 } },
        },
        {},
      ),
      claudeLine(
        { message: { id: 'msg_3', model: '<synthetic>', usage: { input_tokens: 5 } } },
        {},
      ),
    ]
    const out = parseClaudeLines(lines, { seat: 'claude', roots: [ROOT], session: 's1' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      key: 'c:msg_1:req_1',
      tool: 'claude',
      model: 'claude-fable-5-1',
      branch: 'main',
      input: 2,
      output: 50,
      cacheWrite: 100,
      cacheRead: 900,
      side: false,
    })
  })
  it('counts an advisor iteration under its own model', () => {
    const out = parseClaudeLines(
      [
        claudeLine(
          {},
          {
            input_tokens: 1,
            output_tokens: 10,
            iterations: [
              { type: 'message', input_tokens: 1, output_tokens: 10 },
              {
                type: 'advisor_message',
                model: 'claude-opus-5',
                input_tokens: 3,
                output_tokens: 7,
              },
            ],
          },
        ),
      ],
      { seat: 'claude', roots: [ROOT], session: 's1' },
    )
    expect(out.map((e) => [e.key, e.model, e.output])).toEqual([
      ['c:msg_1:req_1', 'claude-fable-5-1', 10],
      ['c:msg_1:advisor:1:req_1', 'claude-opus-5', 7],
    ])
  })
})

describe('UsageStore.upsert', () => {
  it('keeps the streamed copy with the largest total and prefers the non-sidechain copy', () => {
    const store = new UsageStore('/nonexistent')
    const e = (over: Partial<UsageEntry>): UsageEntry => ({
      key: 'c:m:r',
      tool: 'claude',
      seat: 'claude',
      session: 's',
      ts: 1,
      model: 'm',
      cwd: ROOT,
      branch: null,
      input: 0,
      output: 1,
      cacheWrite: 0,
      cacheRead: 0,
      side: false,
      ...over,
    })
    expect(store.upsert(e({ output: 1 }))).toBe('new')
    expect(store.upsert(e({ output: 40 }))).toBe('updated')
    expect(store.upsert(e({ output: 20 }))).toBe('same')
    expect(store.entries.get('c:m:r')?.output).toBe(40)
    expect(store.upsert(e({ output: 99, side: true }))).toBe('same')
    const s2 = new UsageStore('/nonexistent')
    s2.upsert(e({ output: 99, side: true }))
    expect(s2.upsert(e({ output: 5, side: false }))).toBe('updated')
  })
})

describe('parseCodexFile', () => {
  const meta = JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-09-20T05:00:00.000Z',
    payload: { id: 'sess', cwd: ROOT },
  })
  const turn = JSON.stringify({
    type: 'turn_context',
    payload: { model: 'gpt-6-astra', cwd: ROOT },
  })
  const count = (ts: string, total: number[], last: number[]) =>
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: Object.fromEntries(
            [
              'input_tokens',
              'cached_input_tokens',
              'cache_write_input_tokens',
              'output_tokens',
              'reasoning_output_tokens',
            ].map((k, i) => [k, total[i]]),
          ),
          last_token_usage: Object.fromEntries(
            [
              'input_tokens',
              'cached_input_tokens',
              'cache_write_input_tokens',
              'output_tokens',
              'reasoning_output_tokens',
            ].map((k, i) => [k, last[i]]),
          ),
        },
      },
    })

  it('files one entry per advancing token_count with uncached input split from cache reads', () => {
    const text = [
      meta,
      turn,
      count('2026-09-20T05:00:10.000Z', [1000, 800, 0, 50, 10], [1000, 800, 0, 50, 10]),
      count('2026-09-20T05:00:12.000Z', [1000, 800, 0, 50, 10], [1000, 800, 0, 50, 10]), // no advance: ignored
      count('2026-09-20T05:00:40.000Z', [1600, 1300, 0, 90, 20], [600, 500, 0, 40, 10]),
    ].join('\n')
    const out = parseCodexFile(text, { seat: 'codex', roots: [ROOT] })
    expect(out.map((e) => [e.input, e.cacheRead, e.output])).toEqual([
      [200, 800, 50],
      [100, 500, 40],
    ])
    expect(out[0]).toMatchObject({ tool: 'codex', model: 'gpt-6-astra', session: 'sess' })
  })

  it('skips the replayed burst at the head of a forked rollout', () => {
    const text = [
      meta,
      turn,
      count('2026-09-20T05:00:00.100Z', [100, 0, 0, 10, 0], [100, 0, 0, 10, 0]),
      count('2026-09-20T05:00:00.300Z', [200, 0, 0, 20, 0], [100, 0, 0, 10, 0]),
      count('2026-09-20T05:00:00.500Z', [300, 0, 0, 30, 0], [100, 0, 0, 10, 0]),
      count('2026-09-20T05:00:30.000Z', [400, 0, 0, 40, 0], [100, 0, 0, 10, 0]),
    ].join('\n')
    const out = parseCodexFile(text, { seat: 'codex', roots: [ROOT] })
    expect(out).toHaveLength(1)
    expect(out[0]?.ts).toBe(Date.parse('2026-09-20T05:00:30.000Z'))
  })

  it('ignores rollouts for other directories', () => {
    const text = [
      meta.replace(ROOT, '/other'),
      turn.replace(ROOT, '/other'),
      count('2026-09-20T05:00:10.000Z', [1, 0, 0, 1, 0], [1, 0, 0, 1, 0]),
    ].join('\n')
    expect(parseCodexFile(text, { seat: 'codex', roots: [ROOT] })).toEqual([])
  })
})

describe('parseGrokUpdates', () => {
  const turn = (
    ts: number,
    calls: number,
    opts: { prompt?: string; meta?: { eventId: string; agentTimestampMs: number } } = {},
  ) =>
    JSON.stringify({
      method: '_x.ai/session/update',
      timestamp: ts,
      params: {
        sessionId: 'sid',
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: opts.prompt ?? `p${calls}`,
          usage: {
            inputTokens: 1000 * calls,
            cachedReadTokens: 600 * calls,
            outputTokens: 50 * calls,
            costUsdTicks: 1e9 * calls,
            modelCalls: calls,
            modelUsage: {
              'grok-4.6-build': {
                inputTokens: 1000 * calls,
                cachedReadTokens: 600 * calls,
                cacheCreationTokens: 0,
                outputTokens: 50 * calls,
                modelCalls: calls,
                costUsdTicks: 1e9 * calls,
              },
            },
          },
        },
        ...(opts.meta ? { _meta: opts.meta } : {}),
      },
    })
  const ctx = { seat: 'grok', session: 'sid', cwd: ROOT }

  it('emits one entry per completed turn with that turn’s usage and Grok’s own cost', () => {
    const out = parseGrokUpdates(
      [
        turn(1789590000, 1, { meta: { eventId: 'sid-10', agentTimestampMs: 1789590000123 } }),
        turn(1789590300, 3, { meta: { eventId: 'sid-40', agentTimestampMs: 1789590300456 } }),
      ].join('\n'),
      ctx,
    )
    expect(out).toEqual([
      expect.objectContaining({
        key: 'g:sid-10:grok-4.6-build',
        input: 400,
        cacheRead: 600,
        output: 50,
        cost: 0.1,
        calls: 1,
        ts: 1789590000123,
      }),
      expect.objectContaining({
        key: 'g:sid-40:grok-4.6-build',
        input: 1200,
        cacheRead: 1800,
        output: 150,
        cost: 0.3,
        calls: 3,
        ts: 1789590300456,
      }),
    ])
  })

  it('dates a replayed turn by its original event, not the resume', () => {
    const meta = { eventId: 'parent-7', agentTimestampMs: 1789580000999 }
    const original = parseGrokUpdates(turn(1789580001, 2, { prompt: 'p', meta }), {
      ...ctx,
      session: 'parent',
    })
    const replay = parseGrokUpdates(
      [turn(1789590000, 2, { prompt: 'p', meta }), turn(1789590200, 5)].join('\n'),
      ctx,
    )
    expect(replay[0]).toEqual(
      expect.objectContaining({ key: original[0]!.key, ts: 1789580000999, calls: 2 }),
    )
    expect(replay[1]).toEqual(
      expect.objectContaining({ key: 'g:sid:p5:grok-4.6-build', ts: 1789590200000, calls: 5 }),
    )
  })

  it('skips a replayed turn when its origin session is on disk', () => {
    const meta = { eventId: 'parent-7', agentTimestampMs: 1789580000999 }
    const out = parseGrokUpdates(
      [turn(1789590000, 2, { prompt: 'p', meta }), turn(1789590200, 5)].join('\n'),
      { ...ctx, sessions: new Set(['parent', 'sid']) },
    )
    expect(out.map((e) => e.key)).toEqual(['g:sid:p5:grok-4.6-build'])
  })

  it('spreads a turn over its timed model calls, keeping the totals', () => {
    const ev = (ts: string, type: string, extra = {}) => JSON.stringify({ ts, type, ...extra })
    const events = [
      ev('2026-09-21T04:14:46.589Z', 'turn_started', { turn_number: 0 }),
      ev('2026-09-21T04:14:49.444Z', 'loop_started', { loop_index: 0 }),
      ev('2026-09-21T04:14:52.965Z', 'first_token'),
      ev('2026-09-21T04:16:01.197Z', 'loop_started', { loop_index: 1 }),
      ev('2026-09-21T04:20:00.000Z', 'loop_started', { loop_index: 2 }),
      ev('2026-09-21T04:32:29.900Z', 'turn_ended', { outcome: 'completed' }),
      // A later turn still running has no end yet and must not capture the first one.
      ev('2026-09-21T04:37:51.329Z', 'turn_started', { turn_number: 1 }),
      ev('2026-09-21T04:37:52.000Z', 'loop_started', { loop_index: 0 }),
    ].join('\n')
    const endMs = Date.parse('2026-09-21T04:32:29.912Z')
    const out = parseGrokUpdates(
      turn(Math.floor(endMs / 1000), 4, { meta: { eventId: 'sid-99', agentTimestampMs: endMs } }),
      { ...ctx, events },
    )
    expect(out.map((e) => e.key)).toEqual([
      'g:sid-99:grok-4.6-build:0',
      'g:sid-99:grok-4.6-build:1',
      'g:sid-99:grok-4.6-build:2',
    ])
    expect(out.map((e) => e.ts)).toEqual([
      Date.parse('2026-09-21T04:14:49.444Z'),
      Date.parse('2026-09-21T04:16:01.197Z'),
      Date.parse('2026-09-21T04:20:00.000Z'),
    ])
    const sum = (k: 'input' | 'cacheRead' | 'output' | 'calls' | 'cost') =>
      out.reduce((a, e) => a + (e[k] ?? 0), 0)
    expect(sum('input')).toBe(1600)
    expect(sum('cacheRead')).toBe(2400)
    expect(sum('output')).toBe(200)
    expect(sum('calls')).toBe(4)
    expect(sum('cost')).toBeCloseTo(0.4, 9)
    expect(out.map((e) => e.calls)).toEqual([1, 2, 1])
    expect(out.every((e) => Number.isInteger(e.input) && Number.isInteger(e.output))).toBe(true)
  })

  it('lands a turn at its end when the events file has no window for it', () => {
    const endMs = 1789590300456
    const out = parseGrokUpdates(
      turn(1789590300, 3, { meta: { eventId: 'sid-40', agentTimestampMs: endMs } }),
      { ...ctx, events: JSON.stringify({ ts: '2026-09-21T00:00:00Z', type: 'turn_started' }) },
    )
    expect(out).toEqual([
      expect.objectContaining({ key: 'g:sid-40:grok-4.6-build', ts: endMs, calls: 3 }),
    ])
  })
})

describe('PriceBook', () => {
  const book = new PriceBook(
    extractPrices({
      'claude-fable-5-1': {
        mode: 'chat',
        input_cost_per_token: 1e-5,
        output_cost_per_token: 5e-5,
        cache_creation_input_token_cost: 1.25e-5,
        cache_read_input_token_cost: 2.5e-7,
      },
      'anthropic.claude-fable-5-1': {
        mode: 'chat',
        input_cost_per_token: 9,
        output_cost_per_token: 9,
      },
      'vertex_ai/xai/grok-4.6': {
        mode: 'chat',
        input_cost_per_token: 2e-6,
        output_cost_per_token: 6e-6,
      },
      'claude-haiku-4-5-20251001': {
        mode: 'chat',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 5e-6,
      },
      'text-embedding-3': {
        mode: 'embedding',
        input_cost_per_token: 1e-7,
        output_cost_per_token: 0,
      },
    }),
  )
  it('prefers the plain key, strips provider prefixes, shortens suffixes, and finds dated variants', () => {
    expect(book.find('claude-fable-5-1')?.key).toBe('claude-fable-5-1')
    expect(book.find('grok-4.6-build')?.key).toBe('vertex_ai/xai/grok-4.6')
    expect(book.find('claude-haiku-4-5')?.key).toBe('claude-haiku-4-5-20251001')
    expect(book.find('text-embedding-3')).toBeNull()
    expect(book.find('nope-9')).toBeNull()
  })
  it('prices an entry by token class and lets a tool-reported cost win', () => {
    const e: UsageEntry = {
      key: 'k',
      tool: 'claude',
      seat: 'claude',
      session: 's',
      ts: 1,
      model: 'claude-fable-5-1',
      cwd: ROOT,
      branch: null,
      input: 1_000_000,
      output: 100_000,
      cacheWrite: 200_000,
      cacheRead: 4_000_000,
      side: false,
    }
    expect(book.cost(e)).toBeCloseTo(10 + 5 + 2.5 + 1, 6)
    expect(book.cost({ ...e, cost: 0.42 })).toBe(0.42)
  })
})

describe('UsageStore persistence', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'repo-usage-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('reloads entries with the last line for a key winning', async () => {
    const a = new UsageStore(dir)
    const e: UsageEntry = {
      key: 'k',
      tool: 'claude',
      seat: 'claude',
      session: 's',
      ts: 1,
      model: 'm',
      cwd: ROOT,
      branch: null,
      input: 1,
      output: 1,
      cacheWrite: 0,
      cacheRead: 0,
      side: false,
    }
    a.upsert(e)
    await a.persist([e])
    const bigger = { ...e, output: 50 }
    a.upsert(bigger)
    await a.persist([bigger])
    const b = new UsageStore(dir)
    await b.load()
    expect(b.entries.get('k')?.output).toBe(50)
    expect(b.entries.size).toBe(1)
    expect(b.remove('k')).toBe(true)
    await b.persist([])
    const c = new UsageStore(dir)
    await c.load()
    expect(c.entries.size).toBe(0)
  })
})

describe('antigravityEntries', () => {
  it('turns conversations in the repo workspace into unpriced session entries with step counts', async () => {
    const { antigravityEntries } = await import('../src/usage.ts')
    const rows = [
      {
        conversation_id: 'c1',
        step_count: 130,
        last_modified_time: '2026-09-20 06:49:15.0436+00:00',
        workspace_uris: '["file:///Users/me/dev/app"]',
        app_data_dir: 'antigravity-cli',
      },
      {
        conversation_id: 'c2',
        step_count: 5,
        last_modified_time: '2026-09-20 04:53:34+00:00',
        workspace_uris: '["file:///Users/me/dev/other"]',
        app_data_dir: 'antigravity-cli',
      },
      {
        conversation_id: 'c3',
        step_count: 1,
        last_modified_time: '0001-01-01 00:00:00+00:00',
        workspace_uris: '["file:///Users/me/dev/app"]',
        app_data_dir: 'antigravity-cli',
      },
    ]
    const out = antigravityEntries(rows, 'gemini/antigravity-cli', [ROOT])
    expect(out.map((e) => e.key)).toEqual(['a:c1'])
    expect(out[0]).toMatchObject({
      tool: 'antigravity',
      calls: 130,
      cwd: ROOT,
      input: 0,
      output: 0,
    })
  })
})
