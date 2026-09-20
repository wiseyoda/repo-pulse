# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Live feed of every edit with its size, commits rolled up by work item, diff drawer.
- Background by default with instance reuse, `ps`, `--stop`, `--stop-all`, and an idle stop
  (default 2h with no viewer and no activity).
- Opens as a cmux browser tab in the caller's pane when run inside cmux.
- Stats view: activity over time, uncommitted work, repo size, churn by directory, hot files,
  commit types, tests vs source, file mix.
- Markdown files open rendered with the diff painted on; Rendered/Diff toggle; line wrap.
- Narrow layout with tabs for pane-width windows; scroll-anchored feed with a new-rows pill.
- Opt-in LLM usage view: per-repo token usage and API-equivalent cost from Claude Code, Codex,
  and Grok transcripts on this machine, with cost per commit and per 100 lines, trends by tool
  and token class, and breakdowns by model, work item, branch, and account.
