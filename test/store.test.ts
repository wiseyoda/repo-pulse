import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Commit } from '../src/git.ts'
import { EventStore, type NewEvent } from '../src/store.ts'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'repo-pulse-store-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const commit = (sha: string): Commit => ({
  sha,
  ts: 1,
  author: 'a',
  subject: 's',
  refs: '',
  files: [],
  added: 0,
  deleted: 0,
})
const edit = (ts: number, id?: number) => ({
  type: 'edit' as const,
  ts,
  wt: 'w',
  path: 'a.py',
  kind: 'modified' as const,
  status: 'modified' as const,
  dAdded: 1,
  dDeleted: 0,
  added: 1,
  deleted: 0,
  binary: false,
  ...(id === undefined ? {} : { id }),
})

describe('EventStore', () => {
  it('files a commit sha once even when several worktrees reach it', () => {
    const store = new EventStore(null)
    const ev: NewEvent = { type: 'commit', ts: 1, wt: 'main', commit: commit('abc') }
    expect(store.add(ev)).not.toBeNull()
    expect(store.add({ ...ev, wt: 'feature' })).toBeNull()
    expect(store.commits).toHaveLength(1)
  })

  it('drops stale events on load and rewrites the log without them', async () => {
    const log = path.join(dir, 'events.jsonl')
    const now = Date.now()
    const stale = JSON.stringify(edit(now - 30 * 24 * 3600 * 1000, 1))
    const fresh = JSON.stringify(edit(now - 1000, 2))
    writeFileSync(log, `${stale}\n${fresh}\n{"torn":\n`)
    const store = new EventStore(log)
    await store.load()
    expect(store.edits.map((e) => e.id)).toEqual([2])
    const rewritten = readFileSync(log, 'utf8').trim().split('\n')
    expect(rewritten).toEqual([fresh])
    // Ids keep counting from the highest ever seen, including the dropped one.
    const next = store.add(edit(now))
    expect(next?.id).toBe(3)
    await store.flush()
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
