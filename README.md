# repo-pulse

See what agents are doing to a repo as it happens: every edit with its size, every commit, and
the diff one click away.

```sh
repo-pulse ~/dev/some-repo --open
```

Then keep the page open. Rows appear as files change. Click a row for the diff, `j`/`k` to move,
`Esc` to close, `/` to filter. Commits in the window are rolled up by work item id (`W-032`,
`D-43`; change the pattern with `--items`).

## Install

```sh
pnpm install
ln -s "$PWD/bin/repo-pulse" ~/.local/bin/repo-pulse
```

Requires Node 24+ and git. No runtime dependencies.

## Options

| Flag              | Meaning                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `--port <n>`      | Port (default 4747, `0` picks a free one)                                         |
| `--open`          | Open the page: a cmux browser pane when run inside cmux, else the default browser |
| `--items <regex>` | Work-item id pattern for commit roll-ups                                          |
| `--no-persist`    | Don't keep the edit log under `~/.repo-pulse`                                     |
