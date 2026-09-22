# Contributing

Thanks for looking. Pulse is small on purpose: zero runtime dependencies, Node runs the
TypeScript directly, and the page is plain HTML and ES modules. Keep it that way.

## Setup

```sh
git clone https://github.com/wiseyoda/repo-pulse
cd repo-pulse
pnpm install
pnpm start -- -f            # runs against this checkout, attached, page in your browser
```

Node 24 or newer and git are required. `pnpm start [path] [flags]` runs the CLI from source.

## Before you open a pull request

```sh
pnpm verify                 # typecheck + prettier + vitest
```

Everything must pass. `pnpm format` fixes formatting. There is no build step.

- One change per pull request, with a short description of what and why.
- Add or adjust tests for anything under `src/` or the pure helpers in `public/lib.js` and
  `public/md.js`. The page (`public/pulse.js`) is exercised by hand; say what you checked.
- Keep the rules in [AGENTS.md](AGENTS.md): never write into the watched repo, git only runs
  from `src/git.ts`, the server binds loopback only, syntax stays erasable (no enums or
  parameter properties) so Node can run the sources.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
  `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.

## Where things live

| Path               | What                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `src/cli.ts`       | Arguments, instance registry, detach, idle stop, opening the page    |
| `src/watcher.ts`   | Filesystem events → debounced git snapshots → edit events            |
| `src/delta.ts`     | The rules for what counts as an edit                                 |
| `src/git.ts`       | Every git shell-out and its parsers                                  |
| `src/store.ts`     | Ring buffers and the append-only JSONL log                           |
| `src/server.ts`    | HTTP: static files, `/api/*`, `/events` (SSE)                        |
| `src/instances.ts` | `ps`, `--stop-all`, duration parsing, the idle-stop rule             |
| `public/pulse.js`  | The page                                                             |
| `public/lib.js`    | Pure helpers the page shares with tests (feed merge, diff, stats)    |
| `public/md.js`     | Markdown renderer that paints a diff onto the rendered document      |
| `test/`            | Vitest; `git.integration.test.ts` drives a real temporary repository |

## Reporting problems

Use the issue templates. For anything security-related, see [SECURITY.md](SECURITY.md).
