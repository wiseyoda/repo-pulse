import { chmod, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RepostatTracker,
  parseRepostatMetrics,
  statsCommand,
  type RepostatMetrics,
} from '../src/repostat.ts'
import { requestedWorktree } from '../src/server.ts'

function metrics(root: string): RepostatMetrics {
  return {
    schemaVersion: '1',
    artifactType: 'repostat.metrics.v1',
    source: { canonicalRoot: root, gitSha: 'a'.repeat(40) },
    totalFiles: 2,
    totalLines: { total: 12, code: 8, blank: 2, comment: 2 },
    byLanguage: {
      TypeScript: { files: 2, lines: { total: 12, code: 8, blank: 2, comment: 2 } },
    },
    hotspots: [{ file: 'src/a.ts', function: 'run', cyclomatic: 4, cognitive: 3, lines: 12 }],
    dependencies: {
      manifestCount: 1,
      direct: 2,
      transitive: null,
      manifests: [{ name: 'package.json', ecosystem: 'npm', deps: 2 }],
    },
    documentation: {
      fileCount: 1,
      totalLines: 10,
      totalChars: 80,
      docToCodeRatio: 0.25,
      readmeScore: 0.8,
      readmeSections: ['Install'],
      dirCoverage: 0.5,
    },
    skippedFiles: 1,
    riskHotspots: [{ file: 'src/a.ts', churnCount: 5, maxComplexity: 4 }],
  }
}

async function workspace(): Promise<{ dir: string; root: string; state: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'repo-pulse-repostat-'))
  const root = path.join(dir, 'repo')
  const state = path.join(dir, 'state')
  await import('node:fs/promises').then((fs) => fs.mkdir(root))
  return { dir, root, state }
}

async function scanner(dir: string, source: string): Promise<string> {
  const file = path.join(dir, 'fake-repostat')
  await writeFile(file, `#!/usr/bin/env node\n${source}\n`)
  await chmod(file, 0o700)
  return file
}

const successScript = (log: string) => `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const root = args[1]
const payload = ${JSON.stringify(metrics('__ROOT__'))}
payload.source.canonicalRoot = root
process.stdout.write(JSON.stringify(payload))
`

describe('Repostat V1 validation', () => {
  it('accepts the closed schema and binds it to the canonical source root', () => {
    const value = metrics('/tmp/repo')
    expect(parseRepostatMetrics(JSON.stringify(value), '/tmp/repo')).toEqual(value)
  })

  it('rejects wrong versions, extra fields, and mismatched source identity', () => {
    const value = metrics('/tmp/repo')
    expect(() =>
      parseRepostatMetrics(JSON.stringify({ ...value, schemaVersion: '2' }), '/tmp/repo'),
    ).toThrow('incompatible')
    expect(() =>
      parseRepostatMetrics(JSON.stringify({ ...value, surprise: true }), '/tmp/repo'),
    ).toThrow('incompatible')
    expect(() => parseRepostatMetrics(JSON.stringify(value), '/tmp/other')).toThrow('incompatible')
  })
})

describe('RepostatTracker', () => {
  it('defaults to aimux-stats and supports only the explicit AIMUX_STATS_BIN override', () => {
    expect(statsCommand({})).toBe('aimux-stats')
    expect(statsCommand({ AIMUX_STATS_BIN: '/opt/aimux-stats' })).toBe('/opt/aimux-stats')
    expect(statsCommand({ REPOSTAT_BIN: '/opt/repostat' })).toBe('aimux-stats')
  })

  it('uses exact extension arguments, caches outside the repo, and deduplicates refreshes', async () => {
    const { dir, root, state } = await workspace()
    const log = path.join(dir, 'calls.jsonl')
    const command = await scanner(dir, successScript(log))
    const tracker = new RepostatTracker(state, { command })

    const first = await tracker.get(root)
    expect(first).toMatchObject({ stale: false, error: null, metrics: { totalFiles: 2 } })
    await tracker.get(root)
    tracker.invalidate(root)
    const [a, b] = await Promise.all([tracker.get(root), tracker.get(root)])
    expect(a.metrics).toEqual(b.metrics)

    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const canonicalRoot = await realpath(root)
    expect(calls).toEqual([
      ['extension', canonicalRoot],
      ['extension', canonicalRoot],
    ])
    expect(await readdir(root)).toEqual([])
    expect((await readdir(state)).some((name) => name.startsWith('repostat-'))).toBe(true)
    await Promise.all([tracker.get(root, true), tracker.get(root, true)])
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(3)
  })

  it('preserves a stale last-good snapshot when the scanner disappears', async () => {
    const { dir, root, state } = await workspace()
    const command = await scanner(dir, successScript(path.join(dir, 'calls')))
    await new RepostatTracker(state, { command }).get(root)

    const result = await new RepostatTracker(state, {
      command: path.join(dir, 'missing-repostat'),
    }).get(root)
    expect(result.stale).toBe(true)
    expect(result.metrics?.totalFiles).toBe(2)
    expect(result.error).toContain('aimux-stats is not installed')
  })

  it('bounds runtime and output', async () => {
    const { dir, root, state } = await workspace()
    const slow = await scanner(dir, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)
    const timed = await new RepostatTracker(state, { command: slow, timeoutMs: 40 }).get(root)
    expect(timed.error).toContain('timed out')

    const noisy = await scanner(dir, `process.stdout.write('x'.repeat(10000))`)
    const limited = await new RepostatTracker(state, { command: noisy, maxBuffer: 100 }).get(root)
    expect(limited.error).toContain('output exceeded')
  })

  it('cancels an in-flight scanner during shutdown', async () => {
    const { dir, root, state } = await workspace()
    const started = path.join(dir, 'started')
    const command = await scanner(
      dir,
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'yes'); setInterval(() => {}, 1000)`,
    )
    const tracker = new RepostatTracker(state, { command, timeoutMs: 5000 })
    const pending = tracker.get(root)
    while (!(await readFile(started, 'utf8').catch(() => ''))) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    tracker.stop()
    expect((await pending).error).toContain('cancelled')
  })
})

describe('Repostat endpoint', () => {
  it('only resolves a known explicit worktree id', () => {
    const worktrees = [{ id: 'known', path: '/repo', head: null, branch: 'main' }]
    expect(requestedWorktree(worktrees, null)).toBeNull()
    expect(requestedWorktree(worktrees, 'other')).toBeNull()
    expect(requestedWorktree(worktrees, 'known')).toEqual(worktrees[0])
  })
})
