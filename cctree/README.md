# cctree

A prototype: one interactive live map of every running Claude Code session,
grouped Company → Project/Repo → Worktree, with live status (working /
waiting / needs-input) and cccollab channel/topic membership per session.

```
cctree            live TUI: auto-refreshes, ↑↓/j k to move, Enter = jump to that
                   session's pane (tmux or iTerm2), q = quit
cctree once        one-shot plain table (for piping / non-tty)
cctree jump <tty>  jump to the pane on <tty>
```

## Status: prototype, not a shipped feature

**This will not run out of the box.** It shells out to `c9watch`
(`~/.local/bin/c9watch`) for OS-process-scan discovery and status detection,
and `c9watch` is not distributed with cccollab. It also assumes repos are laid
out under `~/projects`. Treat this as a reference implementation rather than a
tool you can install.

It reads `~/.cccollab/logs/default.log` for best-effort, name-joined
channel/topic membership.

The Company column derives its label from the directory name, title-cased. To
override that for a name which doesn't title-case cleanly, create
`~/.cccollab/cctree.json`:

```json
{ "labels": { "acme": "ACME Corp", "bbc": "BBC" } }
```

## Where this is going

The plan is to port the durable pieces natively into cccollab and drop the
`c9watch` runtime dependency:

- Sessions self-declare their identity (repo / worktree / branch / cwd, plus
  the Claude Code session UUID) to cccollab at `introduce`, instead of this
  script reconstructing it from the outside via `c9watch` + git + folder
  layout.
- The broker exposes per-session topic membership directly (`joinedSessions`
  already exists server-side, it just isn't returned by any route today),
  instead of this script's best-effort log-scraping and name-matching.
- This grouped live view ships as a native cccollab CLI feature, not a separate
  script to install and maintain.
- The `c9watch` runtime dependency is dropped; its MIT-licensed status-detection
  logic is vendored, with attribution, for the fallback path that observes
  sessions which haven't self-declared, and discovery (process + cwd) is
  hand-rolled instead.

Until those land, this file is the reference implementation.
