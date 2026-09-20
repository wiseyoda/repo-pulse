# repo-pulse

Live activity feed for a git repo. Watches every worktree, turns each write into an edit event
with its size, and streams it to a local page with diff drill-in and commits rolled up by work item.
Observes only: no hooks, no agent integration, works for any agent or human editing the repo.

## Read first

- `src/watcher.ts` — how filesystem events become debounced git snapshots and edit deltas
- `src/delta.ts` — the rules that decide what counts as an edit (created, modified, reverted, ...)
- `public/pulse.js` — the page; `public/lib.js` holds the pure helpers it shares with tests

## Commands

- `pnpm start [path] [--port N] [--open]` — run against a repo (default: cwd)
- `pnpm verify` — typecheck + prettier + vitest; run before reporting anything done
- `pnpm test` — vitest only (`test/git.integration.test.ts` drives a real temp git repo)

## Layout

- `src/git.ts` — git shell-outs and NUL-safe parsers; no other file calls git
- `src/store.ts` — ring buffers + append-only JSONL under `~/.repo-pulse/<repo>-<id>/`
- `src/server.ts` — plain `node:http`: static files, `/api/state`, `/events` (SSE), diffs
- `src/cli.ts` — arg parsing, wiring, `--open` (cmux browser pane when inside cmux, else default browser)
- `bin/repo-pulse` — shim; symlinked from `~/.local/bin/repo-pulse`

## Rules

- Zero runtime dependencies. Node 24 runs the `.ts` sources directly; keep syntax erasable
  (no enums, no parameter properties).
- Never write into the watched repo. Diff endpoints only accept paths git already reports.
- Commits are re-read from git on start; only edits and HEAD moves are persisted.
- Server binds 127.0.0.1 only.

## Traps

- `fs.watch` recursive on macOS reports `rename` for creates and deletes; the watcher only
  uses events as a trigger and lets git decide what changed.
- Editing an already-changed line keeps `--numstat` identical; the `touched` path set from
  the watcher is what makes that still register as an edit.
- Spotlight-style hidden-dir noise is not a concern here: git's ignore rules filter everything.
