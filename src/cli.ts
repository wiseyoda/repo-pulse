#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repoRoot, worktreeId } from './git.ts'
import { PulseServer } from './server.ts'
import { EventStore } from './store.ts'
import { RepoWatcher } from './watcher.ts'

const DEFAULT_PORT = 4747
const DEFAULT_ITEM_PATTERN = '\\b[A-Z]{1,4}-\\d+\\b'
const CMUX_DEFAULT = '/Applications/cmux.app/Contents/Resources/bin/cmux'

const HELP = `repo-pulse [path] [options]

Live activity feed for a git repo: every edit, its size, and the diff.

Options:
  --port <n>       Port to listen on (default ${DEFAULT_PORT}; 0 picks a free one)
  --open           Open the page in cmux (when inside cmux) or the default browser
  --items <regex>  Work-item id pattern for commit roll-ups (default ${DEFAULT_ITEM_PATTERN})
  --no-persist     Do not keep an edit log under ~/.repo-pulse
  -h, --help       Show this help
`

interface Options {
  target: string
  port: number
  open: boolean
  itemPattern: string
  persist: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    target: process.cwd(),
    port: DEFAULT_PORT,
    open: false,
    itemPattern: DEFAULT_ITEM_PATTERN,
    persist: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP)
      process.exit(0)
    } else if (arg === '--port') opts.port = Number(argv[++i] ?? DEFAULT_PORT)
    else if (arg === '--open') opts.open = true
    else if (arg === '--items') opts.itemPattern = argv[++i] ?? DEFAULT_ITEM_PATTERN
    else if (arg === '--no-persist') opts.persist = false
    else if (arg.startsWith('-')) {
      process.stderr.write(`unknown option ${arg}\n${HELP}`)
      process.exit(2)
    } else opts.target = path.resolve(arg)
  }
  if (!Number.isInteger(opts.port) || opts.port < 0) {
    process.stderr.write('--port must be a non-negative integer\n')
    process.exit(2)
  }
  try {
    new RegExp(opts.itemPattern)
  } catch {
    process.stderr.write('--items must be a valid regular expression\n')
    process.exit(2)
  }
  return opts
}

function findCmux(): string | null {
  const fromEnv = process.env['CMUX_BIN']
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  if (existsSync(CMUX_DEFAULT)) return CMUX_DEFAULT
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'cmux')
    if (dir && existsSync(candidate)) return candidate
  }
  return null
}

function openUrl(url: string, cmuxBin: string | null): void {
  const inCmux = cmuxBin !== null && Boolean(process.env['CMUX_WORKSPACE_ID'])
  const child = inCmux
    ? spawn(cmuxBin, ['browser', 'open', url, '--focus', 'false'], { stdio: 'ignore' })
    : spawn('open', [url], { stdio: 'ignore' })
  child.on('error', (err) => console.error('repo-pulse: could not open browser', err))
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  let root: string
  try {
    root = await repoRoot(opts.target)
  } catch {
    process.stderr.write(`${opts.target} is not inside a git repository\n`)
    process.exit(1)
  }
  const repoName = path.basename(root)
  const logPath = opts.persist
    ? path.join(os.homedir(), '.repo-pulse', `${repoName}-${worktreeId(root)}`, 'events.jsonl')
    : null
  const store = new EventStore(logPath)
  await store.load()

  const cmuxBin = findCmux()
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
  const port = await server.listen(opts.port)
  const url = `http://127.0.0.1:${port}/`
  const wts = watcher.worktrees()
  process.stdout.write(`repo-pulse  ${repoName}  ${url}\n`)
  process.stdout.write(
    `watching ${wts.length} worktree${wts.length === 1 ? '' : 's'}: ${wts.map((w) => w.branch ?? w.head?.slice(0, 7) ?? '?').join(', ')}\n`,
  )
  if (logPath) process.stdout.write(`edit log: ${logPath}\n`)
  if (opts.open) openUrl(url, cmuxBin)

  const shutdown = (): void => {
    watcher.stop()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  console.error('repo-pulse:', err)
  process.exit(1)
})
