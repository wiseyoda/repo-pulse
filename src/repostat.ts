import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CACHE_VERSION = 1
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024

export interface LineMetrics {
  total: number
  code: number
  blank: number
  comment: number
}

export interface RepostatMetrics {
  schemaVersion: '1'
  artifactType: 'repostat.metrics.v1'
  source: { canonicalRoot: string; gitSha: string | null }
  totalFiles: number
  totalLines: LineMetrics
  byLanguage: Record<string, { files: number; lines: LineMetrics }>
  hotspots: {
    file: string
    function: string
    cyclomatic: number
    cognitive: number
    lines: number
  }[]
  dependencies: {
    manifestCount: number
    direct: number
    transitive: number | null
    manifests: { name: string; ecosystem: string; deps: number }[]
  } | null
  documentation: {
    fileCount: number
    totalLines: number
    totalChars: number
    docToCodeRatio: number
    readmeScore: number
    readmeSections: string[]
    dirCoverage: number
  } | null
  skippedFiles: number
  riskHotspots: { file: string; churnCount: number; maxComplexity: number }[]
}

export interface RepostatStatus {
  root: string
  stale: boolean
  scannedAt: number | null
  error: string | null
  metrics: RepostatMetrics | null
}

interface RootState {
  loaded: boolean
  stale: boolean
  generation: number
  scannedAt: number | null
  metrics: RepostatMetrics | null
  inflight: Promise<RepostatStatus> | null
}

interface CacheRecord {
  version: number
  root: string
  scannedAt: number
  metrics: RepostatMetrics
}

interface TrackerOptions {
  command?: string
  timeoutMs?: number
  maxBuffer?: number
}

/** Resolve the public Stats executable, allowing one explicit owner-controlled override. */
export function statsCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.AIMUX_STATS_BIN || 'aimux-stats'
}

const TOP_KEYS = [
  'schemaVersion',
  'artifactType',
  'source',
  'totalFiles',
  'totalLines',
  'byLanguage',
  'hotspots',
  'dependencies',
  'documentation',
  'skippedFiles',
  'riskHotspots',
]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0
const hasKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value)

function isLines(value: unknown): value is LineMetrics {
  if (!isObject(value) || !hasKeys(value, ['total', 'code', 'blank', 'comment'])) return false
  return [value.total, value.code, value.blank, value.comment].every(isCount)
}

function isSource(value: unknown, root: string): boolean {
  if (!isObject(value) || !hasKeys(value, ['canonicalRoot', 'gitSha'])) return false
  const sha = value.gitSha
  return (
    value.canonicalRoot === root &&
    (sha === null || (typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha)))
  )
}

function isLanguages(value: unknown): boolean {
  if (!isObject(value)) return false
  return Object.values(value).every(
    (entry) =>
      isObject(entry) &&
      hasKeys(entry, ['files', 'lines']) &&
      isCount(entry.files) &&
      isLines(entry.lines),
  )
}

function isHotspots(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 10 &&
    value.every(
      (entry) =>
        isObject(entry) &&
        hasKeys(entry, ['file', 'function', 'cyclomatic', 'cognitive', 'lines']) &&
        typeof entry.file === 'string' &&
        typeof entry.function === 'string' &&
        isCount(entry.cyclomatic) &&
        isCount(entry.cognitive) &&
        isCount(entry.lines),
    )
  )
}

function isDependencies(value: unknown): boolean {
  if (value === null) return true
  if (!isObject(value) || !hasKeys(value, ['manifestCount', 'direct', 'transitive', 'manifests']))
    return false
  return (
    isCount(value.manifestCount) &&
    isCount(value.direct) &&
    (value.transitive === null || isCount(value.transitive)) &&
    Array.isArray(value.manifests) &&
    value.manifests.every(
      (entry) =>
        isObject(entry) &&
        hasKeys(entry, ['name', 'ecosystem', 'deps']) &&
        typeof entry.name === 'string' &&
        typeof entry.ecosystem === 'string' &&
        isCount(entry.deps),
    )
  )
}

function isDocumentation(value: unknown): boolean {
  if (value === null) return true
  const keys = [
    'fileCount',
    'totalLines',
    'totalChars',
    'docToCodeRatio',
    'readmeScore',
    'readmeSections',
    'dirCoverage',
  ]
  if (!isObject(value) || !hasKeys(value, keys)) return false
  return (
    isCount(value.fileCount) &&
    isCount(value.totalLines) &&
    isCount(value.totalChars) &&
    typeof value.docToCodeRatio === 'number' &&
    value.docToCodeRatio >= 0 &&
    typeof value.readmeScore === 'number' &&
    value.readmeScore >= 0 &&
    value.readmeScore <= 1 &&
    Array.isArray(value.readmeSections) &&
    value.readmeSections.every((section) => typeof section === 'string') &&
    typeof value.dirCoverage === 'number' &&
    value.dirCoverage >= 0 &&
    value.dirCoverage <= 1
  )
}

function isRisks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isObject(entry) &&
        hasKeys(entry, ['file', 'churnCount', 'maxComplexity']) &&
        typeof entry.file === 'string' &&
        isCount(entry.churnCount) &&
        isCount(entry.maxComplexity),
    )
  )
}

/** Parse the closed Stats metrics payload and bind it to the requested canonical root. */
export function parseRepostatMetrics(text: string, root: string): RepostatMetrics {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Stats returned invalid JSON')
  }
  if (
    !isObject(value) ||
    !hasKeys(value, TOP_KEYS) ||
    value.schemaVersion !== '1' ||
    value.artifactType !== 'repostat.metrics.v1' ||
    !isSource(value.source, root) ||
    !isCount(value.totalFiles) ||
    !isLines(value.totalLines) ||
    !isLanguages(value.byLanguage) ||
    !isHotspots(value.hotspots) ||
    !isDependencies(value.dependencies) ||
    !isDocumentation(value.documentation) ||
    !isCount(value.skippedFiles) ||
    !isRisks(value.riskHotspots)
  ) {
    throw new Error('Stats returned an incompatible metrics payload')
  }
  return value as unknown as RepostatMetrics
}

/** Owns bounded Stats scans and last-good caches outside watched repositories. */
export class RepostatTracker {
  private readonly stateDir: string
  private readonly command: string
  private readonly timeoutMs: number
  private readonly maxBuffer: number
  private readonly roots = new Map<string, RootState>()
  private readonly aliases = new Map<string, string>()
  private readonly controllers = new Set<AbortController>()
  private stopped = false

  constructor(stateDir: string, options: TrackerOptions = {}) {
    this.stateDir = stateDir
    this.command = options.command ?? statsCommand()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
  }

  invalidate(root: string): void {
    const requested = path.resolve(root)
    const state = this.roots.get(this.aliases.get(requested) ?? requested)
    if (!state) return
    state.stale = true
    state.generation++
  }

  async get(root: string, refresh = false): Promise<RepostatStatus> {
    const canonicalRoot = await realpath(root)
    this.aliases.set(path.resolve(root), canonicalRoot)
    const state = await this.load(canonicalRoot)
    if (refresh) state.stale = true
    if (!state.stale && state.metrics) return this.status(canonicalRoot, state, null)
    if (state.inflight) return state.inflight
    state.inflight = this.scan(canonicalRoot, state).finally(() => {
      state.inflight = null
    })
    return state.inflight
  }

  stop(): void {
    this.stopped = true
    for (const controller of this.controllers) controller.abort()
  }

  private async load(root: string): Promise<RootState> {
    let state = this.roots.get(root)
    if (!state) {
      state = {
        loaded: false,
        stale: true,
        generation: 0,
        scannedAt: null,
        metrics: null,
        inflight: null,
      }
      this.roots.set(root, state)
    }
    if (state.loaded) return state
    state.loaded = true
    try {
      const record = JSON.parse(await readFile(this.cachePath(root), 'utf8')) as CacheRecord
      if (record.version === CACHE_VERSION && record.root === root && isCount(record.scannedAt)) {
        state.metrics = parseRepostatMetrics(JSON.stringify(record.metrics), root)
        state.scannedAt = record.scannedAt
      }
    } catch {
      // A missing or incompatible cache simply causes a fresh bounded scan.
    }
    return state
  }

  private async scan(root: string, state: RootState): Promise<RepostatStatus> {
    if (this.stopped) return this.status(root, state, 'Stats scan cancelled')
    const generation = state.generation
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      const { stdout } = await execFileAsync(this.command, ['extension', root], {
        encoding: 'utf8',
        killSignal: 'SIGKILL',
        maxBuffer: this.maxBuffer,
        timeout: this.timeoutMs,
        signal: controller.signal,
      })
      const metrics = parseRepostatMetrics(stdout, root)
      const scannedAt = Date.now()
      state.metrics = metrics
      state.scannedAt = scannedAt
      state.stale = state.generation !== generation
      await this.persist({ version: CACHE_VERSION, root, scannedAt, metrics })
      return this.status(root, state, null)
    } catch (error) {
      state.stale = true
      return this.status(root, state, this.errorMessage(error))
    } finally {
      this.controllers.delete(controller)
    }
  }

  private status(root: string, state: RootState, error: string | null): RepostatStatus {
    return { root, stale: state.stale, scannedAt: state.scannedAt, error, metrics: state.metrics }
  }

  private cachePath(root: string): string {
    const id = createHash('sha256').update(root).digest('hex').slice(0, 16)
    return path.join(this.stateDir, `repostat-${id}.json`)
  }

  private async persist(record: CacheRecord): Promise<void> {
    await mkdir(this.stateDir, { recursive: true })
    const destination = this.cachePath(record.root)
    const temporary = `${destination}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await rename(temporary, destination)
  }

  private errorMessage(error: unknown): string {
    const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
    if (this.stopped || e.name === 'AbortError') return 'Stats scan cancelled'
    if (e.code === 'ENOENT') return 'aimux-stats is not installed or not on PATH'
    if (e.killed || e.signal) return `Stats scan timed out after ${this.timeoutMs}ms`
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Stats output exceeded the limit'
    return e.message ? `Stats scan failed: ${e.message}` : 'Stats scan failed'
  }
}
