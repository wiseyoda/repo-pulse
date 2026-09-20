#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { commonDir, repoRoot, worktreeId } from './git.ts'
import { PulseServer } from './server.ts'
import { EventStore } from './store.ts'
import { RepoWatcher } from './watcher.ts'

const execFileAsync = promisify(execFile)

const DEFAULT_PORT = 4747
const DEFAULT_ITEM_PATTERN = '\\b[A-Z]{1,4}-\\d+\\b'
const CMUX_DEFAULT = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const STATE_DIR = path.join(os.homedir(), '.repo-pulse')
const HEALTH_TIMEOUT_MS = 1500
const DETACH_WAIT_MS = 8000

const HELP = `repo-pulse [path] [options]

Live activity feed for a git repo: every edit, its size, and the diff.
Run it from any directory inside a repo. Inside cmux the page opens as a
browser tab in the pane you ran it from; elsewhere in your default browser.
Running it again for a repo that already has a feed just opens that feed.

Options:
  -d, --detach     Run in the background and return the terminal
  --stop           Stop the background instance for this repo
  --no-open        Do not open the page
  --no-focus       Open the page without switching to it
  --port <n>       Port to listen on (default ${DEFAULT_PORT}, or the next free one; 0 picks any)
  --items <regex>  Work-item id pattern for commit roll-ups (default ${DEFAULT_ITEM_PATTERN})
  --no-persist     Do not keep an edit log under ~/.repo-pulse
  -h, --help       Show this help
`

interface Options {
  target: string
  port: number | null
  open: boolean
  focus: boolean
  detach: boolean
  stop: boolean
  itemPattern: string
  persist: boolean
}

/** What a running instance leaves behind so a later `repo-pulse` for the same repo can find it. */
interface Instance {
  pid: number
  port: number
  root: string
  startedAt: number
}

function fail(msg: string, code = 2): never {
  process.stderr.write(`repo-pulse: ${msg}\n`)
  process.exit(code)
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    target: process.cwd(),
    port: null,
    open: true,
    focus: true,
    detach: false,
    stop: false,
    itemPattern: DEFAULT_ITEM_PATTERN,
    persist: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP)
      process.exit(0)
    } else if (arg === '--port') opts.port = Number(argv[++i] ?? NaN)
    else if (arg === '--open') opts.open = true
    else if (arg === '--no-open') opts.open = false
    else if (arg === '--no-focus') opts.focus = false
    else if (arg === '-d' || arg === '--detach') opts.detach = true
    else if (arg === '--stop') opts.stop = true
    else if (arg === '--items') opts.itemPattern = argv[++i] ?? DEFAULT_ITEM_PATTERN
    else if (arg === '--no-persist') opts.persist = false
    else if (arg.startsWith('-')) fail(`unknown option ${arg}\n${HELP}`)
    else opts.target = path.resolve(arg)
  }
  if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) {
    fail('--port must be an integer between 0 and 65535')
  }
  try {
    new RegExp(opts.itemPattern)
  } catch {
    fail('--items must be a valid regular expression')
  }
  return opts
}

// --- cmux / browser -----------------------------------------------------------

function findCmux(): string | null {
  for (const candidate of [process.env['CMUX_BIN'], process.env['CMUX_BUNDLED_CLI_PATH']]) {
    if (candidate && existsSync(candidate)) return candidate
  }
  if (existsSync(CMUX_DEFAULT)) return CMUX_DEFAULT
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'cmux')
    if (dir && existsSync(candidate)) return candidate
  }
  return null
}

/** The pane the user typed the command in, so the tab lands next to their terminal. */
async function callerPane(cmuxBin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmuxBin, ['identify'], { timeout: 3000 })
    const info = JSON.parse(stdout) as { caller?: { pane_ref?: string } }
    return info.caller?.pane_ref ?? null
  } catch {
    return null
  }
}

async function openInCmux(url: string, cmuxBin: string, focus: boolean): Promise<boolean> {
  const workspace = process.env['CMUX_WORKSPACE_ID']
  if (!workspace) return false
  const pane = await callerPane(cmuxBin)
  const args = ['new-surface', '--type', 'browser', '--url', url, '--workspace', workspace]
  if (pane) args.push('--pane', pane)
  args.push('--focus', focus ? 'true' : 'false')
  try {
    await execFileAsync(cmuxBin, args, { timeout: 5000 })
    return true
  } catch (err) {
    console.error('repo-pulse: cmux could not open a tab', err instanceof Error ? err.message : err)
    return false
  }
}

async function openUrl(url: string, cmuxBin: string | null, focus: boolean): Promise<void> {
  if (cmuxBin && (await openInCmux(url, cmuxBin, focus))) return
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const child = spawn(opener, [url], { stdio: 'ignore', shell: process.platform === 'win32' })
  child.on('error', (err) => console.error('repo-pulse: could not open browser', err.message))
}

// --- instance registry ----------------------------------------------------------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function health(port: number): Promise<{ root: string; pid: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { name?: string; root?: string; pid?: number }
    return body.name === 'repo-pulse' && body.root && body.pid
      ? { root: body.root, pid: body.pid }
      : null
  } catch {
    return null
  }
}

async function readInstance(file: string): Promise<Instance | null> {
  try {
    const inst = JSON.parse(await readFile(file, 'utf8')) as Instance
    if (!alive(inst.pid)) return null
    const h = await health(inst.port)
    return h && h.pid === inst.pid ? inst : null
  } catch {
    return null
  }
}

// --- main -----------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  let root: string
  let common: string
  try {
    root = await repoRoot(opts.target)
    common = await commonDir(root)
  } catch {
    return fail(`${opts.target} is not inside a git repository`, 1)
  }
  // Every worktree of a repo shares one state dir, keyed by the main worktree's path.
  const mainRoot = path.basename(common) === '.git' ? path.dirname(common) : root
  const repoName = path.basename(mainRoot)
  const stateDir = path.join(STATE_DIR, `${repoName}-${worktreeId(mainRoot)}`)
  const instanceFile = path.join(stateDir, 'server.json')
  const cmuxBin = findCmux()

  if (opts.stop) {
    const inst = await readInstance(instanceFile)
    if (!inst) return fail(`no repo-pulse is running for ${repoName}`, 1)
    process.kill(inst.pid, 'SIGTERM')
    await rm(instanceFile, { force: true })
    process.stdout.write(`stopped repo-pulse for ${repoName} (pid ${inst.pid})\n`)
    return
  }

  const running = await readInstance(instanceFile)
  if (running) {
    const url = `http://127.0.0.1:${running.port}/`
    process.stdout.write(`repo-pulse is already running for ${repoName} at ${url}\n`)
    if (opts.open) await openUrl(url, cmuxBin, opts.focus)
    return
  }

  if (opts.detach) return detach(opts, stateDir, instanceFile, cmuxBin)

  const logPath = opts.persist ? path.join(stateDir, 'events.jsonl') : null
  const store = new EventStore(logPath)
  await store.load()

  const watcher = new RepoWatcher(root, {
    onEvents: (events) => {
      for (const ev of events) {
        const filed = store.add(ev)
        if (filed) server.broadcast(filed.type, filed, filed.id)
      }
    },
    onSnapshot: (snapshot) => {
      store.snapshots.set(snapshot.wt.id, snapshot)
      server.broadcast('snapshot', snapshot)
      const sample = store.sample(snapshot)
      if (sample) server.broadcast('sample', sample, sample.id)
    },
    onWorktrees: (wts) => server.broadcast('worktrees', wts),
    onError: (err) => console.error('repo-pulse:', err instanceof Error ? err.message : err),
  })
  const server = new PulseServer({
    root,
    repoName,
    itemPattern: opts.itemPattern,
    cmuxBin,
    store,
    worktrees: () => watcher.worktrees(),
  })

  await watcher.start()
  const port = await listen(server, opts.port)
  const url = `http://127.0.0.1:${port}/`
  await mkdir(stateDir, { recursive: true })
  const inst: Instance = { pid: process.pid, port, root, startedAt: Date.now() }
  await writeFile(instanceFile, JSON.stringify(inst))

  const wts = watcher.worktrees()
  process.stdout.write(`repo-pulse  ${repoName}  ${url}\n`)
  process.stdout.write(
    `watching ${wts.length} worktree${wts.length === 1 ? '' : 's'}: ${wts.map((w) => w.branch ?? w.head?.slice(0, 7) ?? '?').join(', ')}\n`,
  )
  if (logPath) process.stdout.write(`edit log: ${logPath}\n`)
  if (opts.open) await openUrl(url, cmuxBin, opts.focus)

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    watcher.stop()
    server.close()
    Promise.allSettled([store.flush(), rm(instanceFile, { force: true })]).finally(() =>
      process.exit(0),
    )
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGHUP', shutdown)
}

/** The default port, then any free one; an explicit --port is honoured or fails loudly. */
async function listen(server: PulseServer, requested: number | null): Promise<number> {
  if (requested !== null) {
    try {
      return await server.listen(requested)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return fail(code === 'EADDRINUSE' ? `port ${requested} is already in use` : String(err), 1)
    }
  }
  try {
    return await server.listen(DEFAULT_PORT)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    return server.listen(0)
  }
}

/** Re-runs this command in the background with its own log, then waits until it answers. */
async function detach(
  opts: Options,
  stateDir: string,
  instanceFile: string,
  cmuxBin: string | null,
): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const logFile = path.join(stateDir, 'server.log')
  const out = openSync(logFile, 'w')
  const args = process.argv.slice(2).filter((a) => a !== '-d' && a !== '--detach')
  // The child opens nothing; this process does, so the tab lands in the caller's pane.
  args.push('--no-open')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()

  const deadline = Date.now() + DETACH_WAIT_MS
  while (Date.now() < deadline) {
    const inst = await readInstance(instanceFile)
    if (inst && inst.pid === child.pid) {
      const url = `http://127.0.0.1:${inst.port}/`
      process.stdout.write(`repo-pulse running in the background (pid ${inst.pid}) at ${url}\n`)
      process.stdout.write(`log: ${logFile}\nstop with: repo-pulse --stop\n`)
      if (opts.open) await openUrl(url, cmuxBin, opts.focus)
      return
    }
    if (child.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const log = await readFile(logFile, 'utf8').catch(() => '')
  fail(`background instance did not start\n${log.trim()}`, 1)
}

main().catch((err: unknown) => {
  console.error('repo-pulse:', err instanceof Error ? err.message : err)
  process.exit(1)
})
