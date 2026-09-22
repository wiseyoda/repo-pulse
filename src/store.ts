import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EditDelta } from './delta.ts'
import type { Commit, FileStat, Worktree } from './git.ts'

export interface EditEvent extends EditDelta {
  type: 'edit'
  id: number
  ts: number
  wt: string
}

export interface CommitEvent {
  type: 'commit'
  id: number
  ts: number
  wt: string
  commit: Commit
}

/** HEAD moved without new commits reachable from the old one: reset, rebase, or checkout. */
export interface HeadEvent {
  type: 'head'
  id: number
  ts: number
  wt: string
  from: string | null
  to: string | null
  branch: string | null
}

/** A reading of how much uncommitted work a worktree holds, taken when it changes. */
export interface SampleEvent {
  type: 'sample'
  id: number
  ts: number
  wt: string
  files: number
  added: number
  deleted: number
}

export type PulseEvent = EditEvent | CommitEvent | HeadEvent | SampleEvent
export type NewEvent =
  Omit<EditEvent, 'id'> | Omit<CommitEvent, 'id'> | Omit<HeadEvent, 'id'> | Omit<SampleEvent, 'id'>

export interface WorktreeSnapshot {
  wt: Worktree
  files: FileStat[]
  at: number
}

const MAX_EDITS = 5000
const MAX_COMMITS = 2000
const MAX_HEADS = 200
const MAX_SAMPLES = 4000
const SAMPLE_GAP_MS = 20_000
const LOAD_WINDOW_MS = 7 * 24 * 3600 * 1000

/** In-memory ring buffers plus an append-only JSONL log for edits, so a restart keeps the night's history. */
export class EventStore {
  edits: EditEvent[] = []
  commits: CommitEvent[] = []
  heads: HeadEvent[] = []
  samples: SampleEvent[] = []
  snapshots = new Map<string, WorktreeSnapshot>()
  private shas = new Set<string>()
  private nextId = 1
  private writeQueue: Promise<void> = Promise.resolve()

  private readonly logPath: string | null

  constructor(logPath: string | null) {
    this.logPath = logPath
  }

  async load(): Promise<void> {
    if (!this.logPath) return
    let raw = ''
    try {
      raw = await readFile(this.logPath, 'utf8')
    } catch {
      return
    }
    const since = Date.now() - LOAD_WINDOW_MS
    let dropped = 0
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const ev = JSON.parse(line) as PulseEvent
        if (ev.id >= this.nextId) this.nextId = ev.id + 1
        if (ev.ts < since) {
          dropped++
          continue
        }
        if (ev.type === 'edit') this.edits.push(ev)
        else if (ev.type === 'head') this.heads.push(ev)
        else if (ev.type === 'sample') this.samples.push(ev)
      } catch {
        // A torn last line from a crash is not worth failing startup over.
        dropped++
      }
    }
    dropped +=
      Math.max(0, this.edits.length - MAX_EDITS) + Math.max(0, this.heads.length - MAX_HEADS)
    this.edits = this.edits.slice(-MAX_EDITS)
    this.heads = this.heads.slice(-MAX_HEADS)
    if (dropped > 0) await this.compact()
  }

  /** Rewrites the log with only what was kept, so it does not grow without bound. */
  private async compact(): Promise<void> {
    if (!this.logPath) return
    const kept = [...this.edits, ...this.heads, ...this.samples].sort((a, b) => a.id - b.id)
    const tmp = `${this.logPath}.tmp`
    try {
      await mkdir(path.dirname(this.logPath), { recursive: true })
      await writeFile(tmp, kept.map((ev) => JSON.stringify(ev) + '\n').join(''))
      await rename(tmp, this.logPath)
    } catch (err) {
      console.error('aimux-pulse: could not compact event log', err)
    }
  }

  /** Assigns an id, files the event, and persists edits/heads. Commits are re-read from git on start. Returns null for a commit already filed. */
  add(ev: NewEvent): PulseEvent | null {
    // Worktrees share history, so a sha is filed once no matter how many of them reach it.
    if (ev.type === 'commit' && this.shas.has(ev.commit.sha)) return null
    if (ev.type === 'commit') this.shas.add(ev.commit.sha)
    const full = { ...ev, id: this.nextId++ } as PulseEvent
    if (full.type === 'edit') this.edits = [...this.edits, full].slice(-MAX_EDITS)
    else if (full.type === 'commit') this.commits = [...this.commits, full].slice(-MAX_COMMITS)
    else if (full.type === 'sample') this.samples = [...this.samples, full].slice(-MAX_SAMPLES)
    else this.heads = [...this.heads, full].slice(-MAX_HEADS)
    if (full.type !== 'commit') this.persist(full)
    return full
  }

  /**
   * Turns a changed snapshot into a sample of uncommitted work, at most one per worktree per
   * SAMPLE_GAP_MS except when the totals return to zero (a commit), which is always worth a point.
   */
  sample(snapshot: WorktreeSnapshot): SampleEvent | null {
    let added = 0
    let deleted = 0
    for (const f of snapshot.files) {
      added += f.added
      deleted += f.deleted
    }
    const files = snapshot.files.length
    const last = this.samples.findLast((s) => s.wt === snapshot.wt.id)
    if (last && last.files === files && last.added === added && last.deleted === deleted)
      return null
    if (last && files > 0 && snapshot.at - last.ts < SAMPLE_GAP_MS) return null
    const ev = this.add({
      type: 'sample',
      ts: snapshot.at,
      wt: snapshot.wt.id,
      files,
      added,
      deleted,
    })
    return ev?.type === 'sample' ? ev : null
  }

  /** Resolves once every queued append has hit disk; call before exiting. */
  flush(): Promise<void> {
    return this.writeQueue
  }

  private persist(ev: PulseEvent): void {
    if (!this.logPath) return
    const logPath = this.logPath
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(path.dirname(logPath), { recursive: true })
        await appendFile(logPath, JSON.stringify(ev) + '\n')
      })
      .catch((err: unknown) => console.error('aimux-pulse: could not persist event', err))
  }

  /** The page keeps its own window filter; this trims what the initial payload carries. */
  state(): {
    edits: EditEvent[]
    commits: CommitEvent[]
    heads: HeadEvent[]
    samples: SampleEvent[]
    snapshots: WorktreeSnapshot[]
  } {
    return {
      edits: this.edits.slice(-1500),
      commits: this.commits.slice(-600),
      heads: this.heads.slice(-50),
      samples: this.samples.slice(-1500),
      snapshots: [...this.snapshots.values()],
    }
  }
}
