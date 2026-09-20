import { appendFile, mkdir, readFile } from 'node:fs/promises'
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

export type PulseEvent = EditEvent | CommitEvent | HeadEvent
export type NewEvent = Omit<EditEvent, 'id'> | Omit<CommitEvent, 'id'> | Omit<HeadEvent, 'id'>

export interface WorktreeSnapshot {
  wt: Worktree
  files: FileStat[]
  at: number
}

const MAX_EDITS = 5000
const MAX_COMMITS = 2000
const MAX_HEADS = 200
const LOAD_WINDOW_MS = 7 * 24 * 3600 * 1000

/** In-memory ring buffers plus an append-only JSONL log for edits, so a restart keeps the night's history. */
export class EventStore {
  edits: EditEvent[] = []
  commits: CommitEvent[] = []
  heads: HeadEvent[] = []
  snapshots = new Map<string, WorktreeSnapshot>()
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
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const ev = JSON.parse(line) as PulseEvent
        if (ev.ts < since) continue
        if (ev.type === 'edit') this.edits.push(ev)
        else if (ev.type === 'head') this.heads.push(ev)
        if (ev.id >= this.nextId) this.nextId = ev.id + 1
      } catch {
        // A torn last line from a crash is not worth failing startup over.
      }
    }
    this.edits = this.edits.slice(-MAX_EDITS)
    this.heads = this.heads.slice(-MAX_HEADS)
  }

  /** Assigns an id, files the event, and persists edits/heads. Commits are re-read from git on start. Returns null for a commit already filed. */
  add(ev: NewEvent): PulseEvent | null {
    if (
      ev.type === 'commit' &&
      this.commits.some((c) => c.commit.sha === ev.commit.sha && c.wt === ev.wt)
    ) {
      return null
    }
    const full = { ...ev, id: this.nextId++ } as PulseEvent
    if (full.type === 'edit') this.edits = [...this.edits, full].slice(-MAX_EDITS)
    else if (full.type === 'commit') this.commits = [...this.commits, full].slice(-MAX_COMMITS)
    else this.heads = [...this.heads, full].slice(-MAX_HEADS)
    if (full.type !== 'commit') this.persist(full)
    return full
  }

  private persist(ev: PulseEvent): void {
    if (!this.logPath) return
    const logPath = this.logPath
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(path.dirname(logPath), { recursive: true })
        await appendFile(logPath, JSON.stringify(ev) + '\n')
      })
      .catch((err: unknown) => console.error('repo-pulse: could not persist event', err))
  }

  /** The page keeps its own window filter; this trims what the initial payload carries. */
  state(): {
    edits: EditEvent[]
    commits: CommitEvent[]
    heads: HeadEvent[]
    snapshots: WorktreeSnapshot[]
  } {
    return {
      edits: this.edits.slice(-1500),
      commits: this.commits.slice(-600),
      heads: this.heads.slice(-50),
      snapshots: [...this.snapshots.values()],
    }
  }
}
