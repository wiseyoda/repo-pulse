# repo-pulse

See what agents are doing to a repo as it happens: every edit with its size, every commit, and
the diff one click away.

```sh
cd ~/dev/some-repo
repo-pulse            # starts in the background and opens the feed: a cmux tab, or your browser
repo-pulse ps         # every running instance: url, viewers, last activity, when it will stop
repo-pulse --stop     # stop this repo's instance; --stop-all stops every one
repo-pulse -f         # run attached to the terminal instead (logs there, Ctrl-C stops it)
```

Run it from anywhere inside a repo. It survives the terminal closing, and it stops itself once
the repo has been quiet and no page has been open for two hours (`--idle 6h`, `--idle off`),
so forgotten instances do not pile up. Running it again for a repo that already has a feed
just opens that feed; a second repo gets the next free port. Rows appear as files change. Click a
row for the diff, `j`/`k` to move, `Enter` to open, `Esc` to close, `/` to filter, `1`–`5` to
pick a window, `g` to jump to the top, `s` to switch between the feed and the stats view. New
rows queue behind a pill while you are scrolled into history. Commits in the window are rolled
up by work item id (`W-032`, `D-43`; change the pattern with `--items`). Click a worktree chip
to see only that worktree.

**Stats** (`s`, or `/#stats`) is a dashboard for the same window: active minutes, edits,
commits, lines, share of changes landing in tests, uncommitted work, longest quiet gap; lines
added and deleted over time with commits marked; uncommitted work and repo size trend lines;
where the work is by directory, hot files, commit types, and the file mix. Everything comes
from git and the edit log, so it works for any repo.

**Markdown** files open rendered, with added lines highlighted and deleted text struck through
where it was; the Rendered / Diff toggle in the drawer switches to the raw diff. Long diff lines
wrap by default (the `wrap` button turns that off). A drawer's URL (`#file=…`) survives a reload.

## Install

```sh
pnpm install
ln -s "$PWD/bin/repo-pulse" ~/.local/bin/repo-pulse
```

Requires Node 24+ and git. No runtime dependencies.

## Options

| Flag                 | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `--idle <time>`      | Stop after this long with no viewer and no activity (default `2h`; `off` never) |
| `-f`, `--foreground` | Run attached to the terminal instead of in the background                       |
| `--no-open`          | Don't open the page                                                             |
| `--no-focus`         | Open the page without switching to it                                           |
| `--port <n>`         | Port (default 4747 or the next free one; `0` picks any)                         |
| `--items <regex>`    | Work-item id pattern for commit roll-ups                                        |
| `--no-persist`       | Don't keep the edit log under `~/.repo-pulse`                                   |

State lives under `~/.repo-pulse/<repo>-<id>/`: `events.jsonl` (edits and HEAD moves, kept for
7 days), `server.json` (the running instance), and `server.log` when detached.
