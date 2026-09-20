# repo-pulse

Live activity feed for a git repo. Watches every worktree, turns each write into an edit event
with its size, and streams it to a local page with diff drill-in and commits rolled up by work item.
Observes only: no hooks, no agent integration, works for any agent or human editing the repo.

## Read first

- `src/watcher.ts` — how filesystem events become debounced git snapshots and edit deltas
- `src/delta.ts` — the rules that decide what counts as an edit (created, modified, reverted, ...)
- `public/pulse.js` — the page; `public/lib.js` holds the pure helpers it shares with tests
  (feed merging, diff numbering, stats aggregation); `public/md.js` renders markdown with diff
  marks as a pure node tree

## Commands

- `pnpm start [path] [-f] [--no-open] [--port N]` — run against a repo (default: cwd); detaches
  into the background by default (`-f` stays attached) and opens the page, as a cmux browser
  tab in the caller's pane when inside cmux; `--stop` ends the background instance
- `pnpm verify` — typecheck + prettier + vitest; run before reporting anything done
- `pnpm test` — vitest only (`test/git.integration.test.ts` drives a real temp git repo)

## Layout

- `src/git.ts` — git shell-outs and NUL-safe parsers; no other file calls git
- `src/store.ts` — ring buffers + append-only JSONL under `~/.repo-pulse/<repo>-<id>/`, compacted on load
- `src/server.ts` — plain `node:http`: static files, `/api/state`, `/api/health`, `/api/stats`
  (30 days of commit sizes + file mix, cached 60s), `/api/file`, `/events` (SSE), diffs
- `src/cli.ts` — arg parsing, wiring, instance reuse via `server.json`, `--detach`/`--stop`, opening
  the page (`cmux new-surface` in the caller's pane when inside cmux, else the default browser)
- `bin/repo-pulse` — shim; symlinked from `~/.local/bin/repo-pulse`

## Rules

- Zero runtime dependencies. Node 24 runs the `.ts` sources directly; keep syntax erasable
  (no enums, no parameter properties).
- Never write into the watched repo. Every git call runs with `GIT_OPTIONAL_LOCKS=0` so the
  watcher never takes `index.lock` from under an agent. Diff endpoints only accept paths git
  already reports.
- The server refuses non-loopback `Host` headers and cross-origin POSTs; keep it that way.
- Commits are re-read from git on start; edits, HEAD moves, and uncommitted-work samples are
  persisted (samples at most one per worktree per 20s, always when totals hit zero).
- Server binds 127.0.0.1 only. The default port falls back to a free one; an explicit `--port` fails loudly.
- One state dir per repo, keyed by the main worktree, so every worktree shares one log and one instance.

## Traps

- `fs.watch` recursive on macOS reports `rename` for creates and deletes; the watcher only
  uses events as a trigger and lets git decide what changed.
- Editing an already-changed line keeps `--numstat` identical; the `touched` path set from
  the watcher is what makes that still register as an edit.
- Spotlight-style hidden-dir noise is not a concern here: git's ignore rules filter everything.
- The page coalesces renders into one frame; in a background tab (no frames) it falls back to a
  timer. Re-rendering a list with `replaceChildren` clamps `scrollTop` to 0, so renders restore it.
