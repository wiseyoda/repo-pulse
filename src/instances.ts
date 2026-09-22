import { readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const STATE_DIR = path.join(os.homedir(), '.repo-pulse')
const HEALTH_TIMEOUT_MS = 1500

/** What a running instance leaves behind so a later `aimux-pulse` can find it. */
export interface Instance {
  pid: number
  port: number
  root: string
  startedAt: number
}

/** What a live instance reports about itself. */
export interface Health {
  ok: true
  name: 'aimux-pulse'
  root: string
  pid: number
  port: number
  startedAt: number
  viewers: number
  lastViewerAt: number
  lastEventAt: number
  idleMs: number
  stopsAt: number | null
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<Health>
    return body.name === 'aimux-pulse' && body.root && body.pid ? (body as Health) : null
  } catch {
    return null
  }
}

/** The instance recorded in `file` if its process is alive and answering; stale files are removed. */
export async function readInstance(file: string): Promise<(Instance & { health: Health }) | null> {
  let inst: Instance
  try {
    inst = JSON.parse(await readFile(file, 'utf8')) as Instance
  } catch {
    return null
  }
  const h = alive(inst.pid) ? await health(inst.port) : null
  if (!h || h.pid !== inst.pid) {
    await rm(file, { force: true })
    return null
  }
  return { ...inst, health: h }
}

/** Every live instance on this machine, from the per-repo state dirs. */
export async function listInstances(
  stateDir = STATE_DIR,
): Promise<(Instance & { health: Health; dir: string })[]> {
  let dirs: string[]
  try {
    dirs = await readdir(stateDir)
  } catch {
    return []
  }
  const found = await Promise.all(
    dirs.map(async (d) => {
      const inst = await readInstance(path.join(stateDir, d, 'server.json'))
      return inst ? { ...inst, dir: d } : null
    }),
  )
  return found.filter((x): x is Instance & { health: Health; dir: string } => x !== null)
}

/** "30m", "2h", "1d", "90" (minutes); "0", "off", or "never" disable. Null when unparseable. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (t === '0' || t === 'off' || t === 'never') return 0
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)?$/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ?? 'm'
  const mult = unit.startsWith('h') ? 3_600_000 : unit === 'd' ? 86_400_000 : 60_000
  return Math.round(n * mult)
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * When an instance will stop on its own: `idleMs` after the later of the last repo event and
 * the last moment a page was connected. Never while a page is open, never when idle is off.
 */
export function stopsAt(
  now: number,
  idleMs: number,
  viewers: number,
  lastViewerAt: number,
  lastEventAt: number,
  startedAt: number,
): number | null {
  if (idleMs <= 0 || viewers > 0) return null
  const quietSince = Math.max(lastViewerAt, lastEventAt, startedAt)
  return quietSince + idleMs
}

export function shouldStop(
  now: number,
  idleMs: number,
  viewers: number,
  lastViewerAt: number,
  lastEventAt: number,
  startedAt: number,
): boolean {
  const at = stopsAt(now, idleMs, viewers, lastViewerAt, lastEventAt, startedAt)
  return at !== null && now >= at
}
