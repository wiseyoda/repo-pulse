import { remoteUrl } from './git.ts'
import { loadPrices, type PriceBook } from './prices.ts'
import {
  discoverSources,
  readConfig,
  repoNameFromRemote,
  scan,
  TOOLS,
  USAGE_HOME,
  usageDir,
  UsageStore,
  writeConfig,
  type Source,
  type Tool,
  type UsageConfig,
  type UsageEntry,
} from './usage.ts'
import path from 'node:path'

const SCAN_EVERY_MS = 2 * 60_000
const DEFAULT_SOURCES: Record<Tool, boolean> = {
  claude: true,
  codex: true,
  grok: true,
  antigravity: true,
}

export interface UsageStatus {
  enabled: boolean
  repo: string
  remote: string | null
  dir: string
  roots: string[]
  sources: { tool: Tool; seat: string; enabled: boolean }[]
  onFile: number
  lastScanAt: number
  scanning: boolean
  prices: { models: number; fetchedAt: number; source: string }
  unpriced: string[]
}

export interface PricedEntry extends UsageEntry {
  usd: number | null
}

/**
 * Owns the per-repo usage state: an opt-in config under ~/.repo-usage/<repo>/, the entry
 * store, the price book, and a periodic scan of every agent transcript dir on this machine.
 */
export class UsageTracker {
  readonly repo: string
  readonly remote: string | null
  private cfg: UsageConfig | null = null
  private store: UsageStore | null = null
  private book: PriceBook | null = null
  private priceSource = 'none'
  private sources: Source[] = []
  private timer: NodeJS.Timeout | null = null
  private lastScanAt = 0
  private scanning = false
  private readonly worktreeRoots: () => string[]
  private readonly onChange: (changed: number) => void

  private constructor(
    repo: string,
    remote: string | null,
    worktreeRoots: () => string[],
    onChange: (changed: number) => void,
  ) {
    this.repo = repo
    this.remote = remote
    this.worktreeRoots = worktreeRoots
    this.onChange = onChange
  }

  /** Names the repo after its origin remote when it has one, else its directory. */
  static async create(
    root: string,
    worktreeRoots: () => string[],
    onChange: (changed: number) => void,
  ): Promise<UsageTracker> {
    const remote = await remoteUrl(root)
    const repo = (remote && repoNameFromRemote(remote)) || path.basename(root)
    const t = new UsageTracker(repo, remote, worktreeRoots, onChange)
    t.cfg = await readConfig(repo)
    // Sources added after the config was written default to on.
    if (t.cfg) t.cfg = { ...t.cfg, sources: { ...DEFAULT_SOURCES, ...t.cfg.sources } }
    if (t.cfg?.enabled) await t.start()
    return t
  }

  get enabled(): boolean {
    return Boolean(this.cfg?.enabled)
  }

  async enable(): Promise<void> {
    const roots = [...new Set([...(this.cfg?.roots ?? []), ...this.worktreeRoots()])]
    this.cfg = {
      enabled: true,
      repo: this.repo,
      remote: this.remote,
      roots,
      sources: {
        claude: true,
        codex: true,
        grok: true,
        antigravity: true,
        ...(this.cfg?.sources ?? {}),
      },
      createdAt: this.cfg?.createdAt ?? Date.now(),
    }
    await writeConfig(this.cfg)
    await this.start()
  }

  async disable(): Promise<void> {
    if (!this.cfg) return
    this.cfg = { ...this.cfg, enabled: false }
    await writeConfig(this.cfg)
    this.stop()
  }

  private async start(): Promise<void> {
    if (!this.cfg) return
    // Worktrees added since the config was written count too.
    const roots = [...new Set([...this.cfg.roots, ...this.worktreeRoots()])]
    if (roots.length !== this.cfg.roots.length) {
      this.cfg = { ...this.cfg, roots }
      await writeConfig(this.cfg)
    }
    this.store = new UsageStore(usageDir(this.repo))
    await this.store.load()
    this.sources = await discoverSources()
    const { book, source } = await loadPrices(USAGE_HOME)
    this.book = book
    this.priceSource = source
    void this.scanNow()
    this.timer = setInterval(() => void this.scanNow(), SCAN_EVERY_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async scanNow(): Promise<number> {
    if (!this.cfg?.enabled || !this.store || this.scanning) return 0
    this.scanning = true
    try {
      const result = await scan(this.cfg, this.store, this.sources)
      this.lastScanAt = Date.now()
      if (result.changed.length) this.onChange(result.changed.length)
      return result.changed.length
    } catch (err) {
      console.error('repo-pulse: usage scan failed', err instanceof Error ? err.message : err)
      return 0
    } finally {
      this.scanning = false
    }
  }

  /** Entries newer than `since`, each with its API-equivalent cost. */
  entries(since = 0): PricedEntry[] {
    if (!this.store || !this.book) return []
    const out: PricedEntry[] = []
    for (const e of this.store.entries.values()) {
      if (e.ts < since) continue
      out.push({ ...e, usd: this.book.cost(e) })
    }
    return out.sort((a, b) => a.ts - b.ts)
  }

  status(): UsageStatus {
    const unpriced = new Set<string>()
    if (this.store && this.book) {
      for (const e of this.store.entries.values())
        if (e.cost === undefined && !this.book.find(e.model)) unpriced.add(e.model)
    }
    const enabledSources = {
      claude: true,
      codex: true,
      grok: true,
      antigravity: true,
      ...(this.cfg?.sources ?? {}),
    }
    const found = this.sources.length ? this.sources : []
    return {
      enabled: this.enabled,
      repo: this.repo,
      remote: this.remote,
      dir: usageDir(this.repo),
      roots: this.cfg?.roots ?? this.worktreeRoots(),
      sources: found.map((s) => ({ tool: s.tool, seat: s.seat, enabled: enabledSources[s.tool] })),
      onFile: this.store?.entries.size ?? 0,
      lastScanAt: this.lastScanAt,
      scanning: this.scanning,
      prices: {
        models: this.book?.size ?? 0,
        fetchedAt: this.book?.fetchedAt ?? 0,
        source: this.priceSource,
      },
      unpriced: [...unpriced].sort(),
    }
  }

  /** What would be read, for the enable screen before anything is written. */
  async preview(): Promise<{ tool: Tool; seat: string }[]> {
    const sources = await discoverSources()
    return sources
      .filter((s) => TOOLS.includes(s.tool))
      .map((s) => ({ tool: s.tool, seat: s.seat }))
  }
}
