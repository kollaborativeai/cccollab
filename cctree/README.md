# cctree

Stefan's prototype: one interactive live map of every running Claude Code
session, grouped Company → Project/Repo → Worktree, with live status
(working / waiting / needs-input) and cccollab channel/topic membership
per session.

```
cctree            live TUI: auto-refreshes, ↑↓/j k to move, Enter = jump to that
                   session's pane (tmux or iTerm2), q = quit
cctree once        one-shot plain table (for piping / non-tty)
cctree jump <tty>  jump to the pane on <tty>
```

## Status

This is the throwaway-fast prototype, checked in here so it isn't only a
single uncommitted file on Stefan's machine. It currently shells out to
`c9watch` (`~/.local/bin/c9watch`) for OS-process-scan discovery and status
detection, and reads `~/.cccollab/logs/default.log` for best-effort,
name-joined channel/topic membership.

Per [KAI-291](https://flatoutsolutions.atlassian.net/browse/KAI-291), the
target is to port the durable pieces of this natively into cccollab and
drop the `c9watch` runtime dependency:

- **KAI-401** — sessions self-declare their identity (company/repo/worktree/branch/cwd
  - Claude Code session UUID) to cccollab at `introduce`, instead of this
    script reconstructing it from the outside via `c9watch` + git + folder layout.
- **KAI-402** — the broker exposes per-session topic membership directly
  (`joinedSessions` already exists server-side, just isn't returned by any
  route today), instead of this script's best-effort log-scraping/name-matching.
- **KAI-403** — this grouped live view ships as a native cccollab CLI feature,
  not a separate script to install and maintain.
- **KAI-404** — the `c9watch` runtime dependency is dropped; its MIT-licensed
  status-detection logic is vendored (with attribution) for the fallback path
  that observes sessions that haven't self-declared, and discovery
  (process + cwd) is hand-rolled instead.

Until those land, this file is the reference implementation.
