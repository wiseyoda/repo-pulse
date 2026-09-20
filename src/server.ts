import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitPatch, fileDiff, type Worktree } from './git.ts'
import type { EventStore } from './store.ts'

export interface ServerOptions {
  root: string
  repoName: string
  itemPattern: string
  cmuxBin: string | null
  store: EventStore
  worktrees(): Worktree[]
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/pulse.js': { file: 'pulse.js', type: 'text/javascript; charset=utf-8' },
  '/lib.js': { file: 'lib.js', type: 'text/javascript; charset=utf-8' },
}
const HEARTBEAT_MS = 15_000
const MAX_DIFF_BYTES = 2 * 1024 * 1024
const SHA_RE = /^[0-9a-f]{7,40}$/

export class PulseServer {
  readonly server: http.Server
  private readonly clients = new Set<http.ServerResponse>()
  private readonly heartbeat: NodeJS.Timeout

  private readonly opts: ServerOptions

  constructor(opts: ServerOptions) {
    this.opts = opts
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        console.error('repo-pulse: request failed', err)
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
        resolve(typeof addr === 'object' && addr ? addr.port : port)
      })
    })
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const c of this.clients) c.end()
    this.server.close()
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    const asset = STATIC[url.pathname]
    if (method === 'GET' && asset) {
      const body = await readFile(path.join(PUBLIC_DIR, asset.file))
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-cache' })
      res.end(body)
      return
    }
    if (method === 'GET' && url.pathname === '/events') return this.stream(req, res)
    if (method === 'GET' && url.pathname === '/api/state') return this.json(res, this.state())
    if (method === 'GET' && url.pathname === '/api/diff') return this.diff(url, res)
    if (method === 'GET' && url.pathname === '/api/commit') return this.commit(url, res)
    if (method === 'POST' && url.pathname === '/api/cmux-diff') return this.cmuxDiff(url, res)
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  private state(): unknown {
    return {
      repo: { name: this.opts.repoName, root: this.opts.root },
      worktrees: this.opts.worktrees(),
      itemPattern: this.opts.itemPattern,
      cmux: this.opts.cmuxBin !== null,
      now: Date.now(),
      ...this.opts.store.state(),
    }
  }

  private json(res: http.ServerResponse, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
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
    req.on('close', () => this.clients.delete(res))
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
