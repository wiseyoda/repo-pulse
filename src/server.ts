import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FleetUsageTracker } from './fleet-usage.ts'
import { commitPatch, fileDiff, fileMix, readCommits, type Worktree } from './git.ts'
import { stopsAt, type Health } from './instances.ts'
import type { RepostatTracker } from './repostat.ts'
import type { EventStore } from './store.ts'
import type { UsageTracker } from './usage-tracker.ts'

export interface ServerOptions {
  root: string
  repoName: string
  itemPattern: string
  cmuxBin: string | null
  store: EventStore
  worktrees(): Worktree[]
  /** Idle budget in ms (0 = never stop) and the last repo event, for the health report. */
  idleMs: number
  lastEventAt(): number
  repostat: RepostatTracker
  usage: UsageTracker
  fleet: FleetUsageTracker
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/pulse.js': { file: 'pulse.js', type: 'text/javascript; charset=utf-8' },
  '/lib.js': { file: 'lib.js', type: 'text/javascript; charset=utf-8' },
  '/md.js': { file: 'md.js', type: 'text/javascript; charset=utf-8' },
}
const HEARTBEAT_MS = 15_000
const MAX_DIFF_BYTES = 2 * 1024 * 1024
const SHA_RE = /^[0-9a-f]{7,40}$/
const STATS_TTL_MS = 60_000
const STATS_DAYS = 30
const STATS_MAX_COMMITS = 2000

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

function sameOrigin(req: http.IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (site) return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return isLoopbackHost(new URL(origin).host)
  } catch {
    return false
  }
}

/** Resolve only an explicit ID from the server's current worktree inventory. */
export function requestedWorktree(worktrees: Worktree[], id: string | null): Worktree | null {
  return worktrees.find((worktree) => worktree.id === id) ?? null
}

export class PulseServer {
  readonly server: http.Server
  private readonly clients = new Set<http.ServerResponse>()
  private readonly heartbeat: NodeJS.Timeout
  private stats: { at: number; body: unknown } | null = null
  readonly startedAt = Date.now()
  /** When the last page disconnected; `startedAt` until one ever connects. */
  lastViewerAt = Date.now()
  private port = 0

  private readonly opts: ServerOptions

  constructor(opts: ServerOptions) {
    this.opts = opts
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        console.error('aimux-pulse: request failed', err)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('error')
      })
    })
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n')
    }, HEARTBEAT_MS)
  }

  broadcast(type: string, data: unknown, id?: number): void {
    const head = id === undefined ? '' : `id: ${id}\n`
    const msg = `${head}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of this.clients) c.write(msg)
  }

  listen(port: number, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        const addr = this.server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : port
        resolve(this.port)
      })
    })
  }

  get viewers(): number {
    return this.clients.size
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const c of this.clients) c.end()
    this.server.close()
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    // Loopback only, and only from our own page: a site you visit must not be able to reach
    // the diff endpoints through DNS rebinding or a cross-origin POST.
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(421, { 'content-type': 'text/plain' })
      return void res.end('wrong host')
    }
    if (method !== 'GET' && !sameOrigin(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      return void res.end('forbidden')
    }

    const asset = STATIC[url.pathname]
    if (method === 'GET' && asset) {
      const body = await readFile(path.join(PUBLIC_DIR, asset.file))
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' })
      res.end(body)
      return
    }
    if (method === 'GET' && url.pathname === '/events') return this.stream(req, res)
    if (method === 'GET' && url.pathname === '/api/state') return this.json(res, this.state())
    if (method === 'GET' && url.pathname === '/api/health') return this.json(res, this.health())
    if (method === 'GET' && url.pathname === '/api/repostat') return this.repostat(url, res)
    if (method === 'GET' && url.pathname === '/api/usage') return this.usage(url, res)
    if (method === 'GET' && url.pathname === '/api/fleet-usage') return this.fleetUsage(url, res)
    if (method === 'POST' && url.pathname === '/api/usage/enable')
      return this.usageToggle(res, true)
    if (method === 'POST' && url.pathname === '/api/usage/disable')
      return this.usageToggle(res, false)
    if (method === 'POST' && url.pathname === '/api/usage/scan') return this.usageScan(res)
    if (method === 'GET' && url.pathname === '/api/stats')
      return this.json(res, await this.repoStats())
    if (method === 'GET' && url.pathname === '/api/diff') return this.diff(url, res)
    if (method === 'GET' && url.pathname === '/api/file') return this.file(url, res)
    if (method === 'GET' && url.pathname === '/api/commit') return this.commit(url, res)
    if (method === 'POST' && url.pathname === '/api/cmux-diff') return this.cmuxDiff(url, res)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  /** Enough for another `aimux-pulse` process to recognise and describe this instance. */
  private health(): Health {
    const now = Date.now()
    const lastEventAt = this.opts.lastEventAt()
    return {
      ok: true,
      name: 'aimux-pulse',
      root: this.opts.root,
      pid: process.pid,
      port: this.port,
      startedAt: this.startedAt,
      viewers: this.viewers,
      lastViewerAt: this.lastViewerAt,
      lastEventAt,
      idleMs: this.opts.idleMs,
      stopsAt: stopsAt(
        now,
        this.opts.idleMs,
        this.viewers,
        this.lastViewerAt,
        lastEventAt,
        this.startedAt,
      ),
    }
  }

  /** Status plus every priced entry in the last `days` (default 30), for the usage view. */
  private async usage(url: URL, res: http.ServerResponse): Promise<void> {
    const t = this.opts.usage
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30))
    const status = t.status()
    this.json(res, {
      ...status,
      preview: status.enabled ? [] : await t.preview(),
      entries: status.enabled ? t.entries(Date.now() - days * 86_400_000) : [],
      days,
    })
  }

  /**
   * The optional fleet slice for the configured repository. Only `refresh` is accepted:
   * the source and repository ID come from owner config, never from the browser.
   */
  private async fleetUsage(url: URL, res: http.ServerResponse): Promise<void> {
    const refresh = url.searchParams.get('refresh') === '1'
    try {
      this.json(res, await this.opts.fleet.get(refresh))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.json(res, { ...this.opts.fleet.status(), error: message })
    }
  }

  private async usageToggle(res: http.ServerResponse, on: boolean): Promise<void> {
    if (on) await this.opts.usage.enable()
    else await this.opts.usage.disable()
    this.json(res, this.opts.usage.status())
  }

  private async usageScan(res: http.ServerResponse): Promise<void> {
    const changed = await this.opts.usage.scanNow()
    this.json(res, { changed, ...this.opts.usage.status() })
  }

  private async repostat(url: URL, res: http.ServerResponse): Promise<void> {
    const wt = requestedWorktree(this.opts.worktrees(), url.searchParams.get('wt'))
    if (!wt) return this.json(res, { error: 'unknown worktree' }, 400)
    try {
      this.json(res, await this.opts.repostat.get(wt.path, url.searchParams.get('refresh') === '1'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.json(res, {
        root: wt.path,
        stale: true,
        scannedAt: null,
        error: `Stats scan failed: ${message}`,
        metrics: null,
      })
    }
  }

  /** Repo-level figures the page cannot derive from live events: 30 days of commit sizes and the file mix. */
  private async repoStats(): Promise<unknown> {
    if (this.stats && Date.now() - this.stats.at < STATS_TTL_MS) return this.stats.body
    const root = this.opts.root
    const [commits, files] = await Promise.all([
      readCommits(root, ['-n', String(STATS_MAX_COMMITS), `--since=${STATS_DAYS} days ago`]),
      fileMix(root),
    ])
    const body = {
      days: STATS_DAYS,
      commits: commits.map((c) => ({ sha: c.sha, ts: c.ts, added: c.added, deleted: c.deleted })),
      files,
      at: Date.now(),
    }
    this.stats = { at: Date.now(), body }
    return body
  }

  private state(): unknown {
    return {
      repo: { name: this.opts.repoName, root: this.opts.root },
      worktrees: this.opts.worktrees(),
      itemPattern: this.opts.itemPattern,
      cmux: this.opts.cmuxBin !== null,
      usageEnabled: this.opts.usage.enabled,
      now: Date.now(),
      ...this.opts.store.state(),
    }
  }

  private json(res: http.ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
    res.end(JSON.stringify(body))
  }

  private text(res: http.ServerResponse, body: string, status = 200): void {
    const truncated = body.length > MAX_DIFF_BYTES
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.end(truncated ? body.slice(0, MAX_DIFF_BYTES) + '\n\n[truncated]\n' : body)
  }

  private stream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    this.clients.add(res)
    req.on('close', () => {
      this.clients.delete(res)
      this.lastViewerAt = Date.now()
    })
  }

  /** Resolves ?wt=&path= to a file in the current snapshot, so only paths git already reports can be diffed. */
  private lookup(url: URL): { wt: Worktree; file: import('./git.ts').FileStat } | null {
    const wtId = url.searchParams.get('wt') ?? ''
    const p = url.searchParams.get('path') ?? ''
    const snap = this.opts.store.snapshots.get(wtId)
    const file = snap?.files.find((f) => f.path === p)
    return snap && file ? { wt: snap.wt, file } : null
  }

  private async diff(url: URL, res: http.ServerResponse): Promise<void> {
    const hit = this.lookup(url)
    if (!hit) return this.text(res, 'No such file in the current working tree.', 404)
    this.text(res, await fileDiff(hit.wt.path, hit.file))
  }

  /** Current working-tree contents of a file git reports as changed; the page renders markdown from it. */
  private async file(url: URL, res: http.ServerResponse): Promise<void> {
    const hit = this.lookup(url)
    if (!hit) return this.text(res, 'No such file in the current working tree.', 404)
    if (hit.file.status === 'deleted') return this.text(res, 'File was deleted.', 404)
    const abs = path.join(hit.wt.path, hit.file.path)
    if (!abs.startsWith(hit.wt.path + path.sep)) return this.text(res, 'Bad request.', 400)
    try {
      const buf = await readFile(abs)
      if (buf.subarray(0, 8000).includes(0)) return this.text(res, 'Binary file.', 415)
      this.text(res, buf.toString('utf8'))
    } catch {
      this.text(res, 'Could not read the file.', 404)
    }
  }

  private async commit(url: URL, res: http.ServerResponse): Promise<void> {
    const wt = this.opts.worktrees().find((w) => w.id === url.searchParams.get('wt'))
    const sha = url.searchParams.get('sha') ?? ''
    if (!wt || !SHA_RE.test(sha)) return this.text(res, 'Bad request.', 400)
    this.text(res, await commitPatch(wt.path, sha))
  }

  private async cmuxDiff(url: URL, res: http.ServerResponse): Promise<void> {
    const bin = this.opts.cmuxBin
    if (!bin) return this.json(res, { ok: false, reason: 'cmux not available' })
    const sha = url.searchParams.get('sha')
    let patch: string
    let title: string
    if (sha) {
      const wt = this.opts.worktrees().find((w) => w.id === url.searchParams.get('wt'))
      if (!wt || !SHA_RE.test(sha)) return this.json(res, { ok: false, reason: 'bad request' })
      patch = await commitPatch(wt.path, sha)
      title = sha.slice(0, 7)
    } else {
      const hit = this.lookup(url)
      if (!hit) return this.json(res, { ok: false, reason: 'no such file' })
      patch = await fileDiff(hit.wt.path, hit.file)
      title = hit.file.path
    }
    const child = spawn(bin, ['diff', '-', '--title', title, '--focus', 'false'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdin.end(patch)
    const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)))
    this.json(
      res,
      code === 0 ? { ok: true } : { ok: false, reason: stderr.trim() || `exit ${code}` },
    )
  }
}
