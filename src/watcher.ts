import { existsSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { diffWorkingTrees } from './delta.ts'
import {
  commitsBetween,
  gitDir,
  headSha,
  listWorktrees,
  readCommits,
  readWorkingTree,
  type FileStat,
  type Worktree,
} from './git.ts'
import type { NewEvent, WorktreeSnapshot } from './store.ts'

export type Emitted = NewEvent

export interface WatcherHooks {
  onEvents(events: Emitted[]): void
  onSnapshot(snapshot: WorktreeSnapshot): void
  onError(err: unknown): void
}

const DEBOUNCE_MS = 300
const MAX_WAIT_MS = 1500
const HEAD_POLL_MS = 4000
const HISTORY_HOURS = 24
const HISTORY_MAX = 500

/** Watches one worktree: filesystem events feed a debounced git snapshot; reflog writes and a slow poll catch commits. */
export class WorktreeWatcher {
  private prev = new Map<string, FileStat>()
  private head: string | null = null
  private touched = new Set<string>()
  private debounce: NodeJS.Timeout | null = null
  private maxWait: NodeJS.Timeout | null = null
  private poll: NodeJS.Timeout | null = null
  private watchers: FSWatcher[] = []
  private running = false
  private dirty = false
  private stopped = false

  wt: Worktree
  private readonly hooks: WatcherHooks

  constructor(wt: Worktree, hooks: WatcherHooks) {
    this.wt = wt
    this.hooks = hooks
  }

  async start(): Promise<void> {
    const root = this.wt.path
    this.head = await headSha(root)
    this.prev = await readWorkingTree(root, this.head)
    this.hooks.onSnapshot({ wt: this.wt, files: [...this.prev.values()], at: Date.now() })

    if (this.head) {
      const since = `--since=${HISTORY_HOURS} hours ago`
      const history = await readCommits(root, ['-n', String(HISTORY_MAX), since])
      this.hooks.onEvents(
        history
          .reverse()
          .map((commit) => ({ type: 'commit', ts: commit.ts, wt: this.wt.id, commit })),
      )
    }

    this.watchers.push(
      watch(root, { recursive: true }, (_event, name) => {
        if (name === null) return this.schedule()
        const rel = name.toString()
        if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) return
        this.touched.add(rel)
        this.schedule()
      }),
    )
    const reflog = path.join(await gitDir(root), 'logs', 'HEAD')
    if (existsSync(reflog)) this.watchers.push(watch(reflog, () => this.schedule()))
    for (const w of this.watchers) w.on('error', (err) => this.hooks.onError(err))
    this.poll = setInterval(() => void this.pollHead(), HEAD_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    for (const w of this.watchers) w.close()
    if (this.poll) clearInterval(this.poll)
    if (this.debounce) clearTimeout(this.debounce)
    if (this.maxWait) clearTimeout(this.maxWait)
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.fire(), DEBOUNCE_MS)
    if (!this.maxWait) this.maxWait = setTimeout(() => this.fire(), MAX_WAIT_MS)
  }

  private fire(): void {
    if (this.debounce) clearTimeout(this.debounce)
    if (this.maxWait) clearTimeout(this.maxWait)
    this.debounce = null
    this.maxWait = null
    void this.tick()
  }

  private async pollHead(): Promise<void> {
    if (this.running) return
    try {
      if ((await headSha(this.wt.path)) !== this.head) this.schedule()
    } catch (err) {
      this.hooks.onError(err)
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.dirty = true
      return
    }
    this.running = true
    try {
      do {
        this.dirty = false
        await this.refresh()
      } while (this.dirty && !this.stopped)
    } catch (err) {
      this.hooks.onError(err)
    } finally {
      this.running = false
    }
  }

  private async refresh(): Promise<void> {
    const root = this.wt.path
    const touched = this.touched
    this.touched = new Set()
    const now = Date.now()
    const head = await headSha(root)
    const next = await readWorkingTree(root, head)
    const out: Emitted[] = []

    if (head !== this.head) {
      const fresh = head ? await commitsBetween(root, this.head, head) : []
      if (fresh.length) {
        out.push(
          ...fresh
            .reverse()
            .map((commit): Emitted => ({ type: 'commit', ts: commit.ts, wt: this.wt.id, commit })),
        )
      } else {
        out.push({
          type: 'head',
          ts: now,
          wt: this.wt.id,
          from: this.head,
          to: head,
          branch: this.wt.branch,
        })
      }
      this.head = head
      const refreshed = (await listWorktrees(root)).find((w) => w.path === root)
      if (refreshed) this.wt = refreshed
    } else {
      for (const d of diffWorkingTrees(this.prev, next, touched)) {
        out.push({ type: 'edit', ts: now, wt: this.wt.id, ...d })
      }
    }
    this.prev = next
    if (out.length) this.hooks.onEvents(out)
    this.hooks.onSnapshot({ wt: this.wt, files: [...next.values()], at: now })
  }
}

const WORKTREE_POLL_MS = 10_000

/** Keeps one WorktreeWatcher per worktree of a repo, picking up worktrees added or removed while running. */
export class RepoWatcher {
  private watchers = new Map<string, WorktreeWatcher>()
  private poll: NodeJS.Timeout | null = null

  readonly root: string
  private readonly hooks: WatcherHooks & { onWorktrees(wts: Worktree[]): void }

  constructor(root: string, hooks: WatcherHooks & { onWorktrees(wts: Worktree[]): void }) {
    this.root = root
    this.hooks = hooks
  }

  async start(): Promise<void> {
    await this.sync()
    this.poll = setInterval(() => void this.sync().catch(this.hooks.onError), WORKTREE_POLL_MS)
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll)
    for (const w of this.watchers.values()) w.stop()
    this.watchers.clear()
  }

  worktrees(): Worktree[] {
    return [...this.watchers.values()].map((w) => w.wt)
  }

  private async sync(): Promise<void> {
    const listed = await listWorktrees(this.root)
    const seen = new Set(listed.map((w) => w.path))
    let changed = false
    for (const [p, w] of this.watchers) {
      if (seen.has(p)) continue
      w.stop()
      this.watchers.delete(p)
      changed = true
    }
    for (const wt of listed) {
      if (this.watchers.has(wt.path)) continue
      const watcher = new WorktreeWatcher(wt, this.hooks)
      this.watchers.set(wt.path, watcher)
      await watcher.start()
      changed = true
    }
    if (changed) this.hooks.onWorktrees(this.worktrees())
  }
}
