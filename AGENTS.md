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
- `src/cli.ts` — arg parsing, wiring, `ps`/`--stop`/`--stop-all`, the idle-stop timer, opening the
  page (`cmux new-surface` in the caller's pane when inside cmux, else the default browser)
- `src/instances.ts` — the instance registry (`~/.repo-pulse/*/server.json` + `/api/health`),
  duration parsing, and the pure idle-stop rule
- `src/usage.ts` — LLM usage: source discovery (`~/.claude*`, `~/.codex*`, `~/.grok*`), pure
  parsers per tool that mirror ccusage's dedupe rules, the keyed entry store under
  `~/.repo-usage/<repo>/`, and the incremental scan. `src/prices.ts` is the LiteLLM price
  book; `src/usage-tracker.ts` owns config, scan timer, and pricing for one repo
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
- An instance stops itself after `--idle` (default 2h) with no SSE viewer and no repo event; never
  while a page is connected. Replayed history at start does not count as activity.
- Usage tracking is opt-in per repo and reads usage/metadata fields only, never transcript
  content. Claude streams rewrite a message several times: keep the copy with the largest
  total, non-sidechain preferred, keyed on (message id, request id). Codex forks replay history
  as a sub-second burst at the head of the file: skip it. Grok logs one `turn_completed`
  line per prompt with that turn's usage (not a running total) and only per turn, but its
  events.jsonl times every model call (`loop_started`), so a turn is spread evenly over its
  calls. A resumed session replays its parent's turns with the line `timestamp` reset; `_meta`
  keeps the original event id and time, and the replay is skipped when the origin session is on
  disk. Subagent transcripts sit under
  `<session>/subagents/`, so the Claude walk must go several levels deep. A Codex rollout's
  `session_meta` line can run past 4 KB, so read to its newline, not a fixed head. Antigravity
  is read through `node:sqlite` (built in, still zero dependencies): `conversation_summaries.db`
  maps conversations to workspaces, and each `conversations/<id>.db` holds protobuf blobs that
  `src/antigravity.ts` decodes with ccusage's field numbers, model-id table, and identity
  merge. Fresh writes land in the `-wal` file, so change detection stats both. Bump
  `CURSOR_VERSION` in `src/usage.ts` whenever a cached skip decision could change; superseded
  entries are removed with tombstone lines in `usage.jsonl`.

## Traps

- `fs.watch` recursive on macOS reports `rename` for creates and deletes; the watcher only
  uses events as a trigger and lets git decide what changed.
- Editing an already-changed line keeps `--numstat` identical; the `touched` path set from
  the watcher is what makes that still register as an edit.
- Spotlight-style hidden-dir noise is not a concern here: git's ignore rules filter everything.
- The page coalesces renders into one frame; in a background tab (no frames) it falls back to a
  timer. Re-rendering a list with `replaceChildren` clamps `scrollTop` to 0, so renders restore it.
