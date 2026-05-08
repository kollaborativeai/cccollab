# Two MCP servers, one repository

This repository is on a path to host **two separate MCP servers** with
non-overlapping audiences. They must never be conflated - not in code, not in
docs, not in conversation. Each has a different transport, a different runtime
location, and a different audience.

| Name                       | Transport                            | Runs where                                                        | Audience                                                          | Status                                                            |
| -------------------------- | ------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Local MCP server**       | stdio (Claude Code Channel protocol) | Developer's machine, spawned by Claude Code                       | Developers using Claude Code                                      | Implemented. Lives in `mcp_server/`.                              |
| **Hosted HTTP MCP server** | HTTP (Streamable HTTP MCP)           | Inside the Convex deployment, via `convex/http.ts` + HTTP actions | Non-technical users on external LLMs - Claude.ai, ChatGPT, Gemini | Future work (out of scope for CCC-3). Will live inside `convex/`. |

## Why there are two and why they stay separate

Claude Code's `notifications/claude/channel` protocol only exists over stdio.
External LLM clients cannot speak that protocol - they access MCP over HTTP.
A single server cannot satisfy both audiences because the transport envelopes
are different and because Claude Code's Channel protocol emits Claude-Code-
specific UI affordances (the `<channel source="cccollab" ...>` tag) that are
not appropriate for a general-purpose HTTP MCP server.

The **backend** can and should be shared: both the local stdio server's remote
transport (see `mcp_server/src/transport/remote.ts`) and the future HTTP MCP
server will call the same Convex queries and mutations. Shared backend, two
clients.

## Where each server's code lives

### Local MCP server (this repo, implemented)

```
mcp_server/
├── bin/cccollab                    # Launcher, installed as the `cccollab` bin
├── src/
│   ├── server.ts                   # Stdio server entry
│   ├── broker.ts                   # Local HTTP+SSE broker (unchanged from pre-CCC-3)
│   ├── broker-*.ts                 # Local-mode support
│   ├── message-bus.ts              # Pushes Channel-protocol notifications
│   ├── transport/
│   │   ├── index.ts                # Transport abstraction interface
│   │   ├── local.ts                # Wraps the local broker HTTP+SSE
│   │   ├── remote.ts               # Wraps the Convex client (subscriptions + mutations)
│   │   ├── router.ts               # Per-call routing across enabled transports
│   │   └── attach.ts               # Cold-start + hot-attach of non-local locations
│   ├── remote/                     # Remote-mode helpers: Convex client factory, auth flow
│   ├── config/                     # Unified config loader (user + project + env)
│   └── tools/                      # Tool implementations, call through transports
└── tests/
```

Runtime:

- Claude Code starts it via stdio: `cccollab` binary.
- It always starts a local broker (unchanged behaviour).
- When `~/.cccollab/config.json` declares a non-local location under
  `locations` (a Convex deployment URL plus persisted OAuth tokens), the
  server **also** attaches a remote transport to that deployment. Operations
  routed to that location flow over the remote transport; operations routed
  to the reserved `local` location stay on the in-process broker.
  Fan-out and merging happen per-call based on the location the tool names.
- The `authenticate` tool performs Google OAuth and hot-attaches the remote
  transport to the running session (no restart). On a `force: true` re-auth
  the old transport is torn down (DM unsubscribe fired, `shutdown()` called,
  ConvexClient websocket closed) before the new one is swapped in.
- When only local is available, behaviour is identical to pre-CCC-3.

### Hosted HTTP MCP server (future - NOT in this story)

Will live alongside the Convex backend, in `convex/`:

```
convex/
├── http.ts                         # HTTP router, already a Convex primitive
├── mcp/                            # FUTURE - HTTP MCP server code
│   ├── listTools.ts
│   ├── callTool.ts
│   └── server.ts
├── channels/                       # Data layer shared by both servers
├── topics/
├── messages/
└── ... (shared schemas, queries, mutations)
```

Runtime:

- External LLM (Claude.ai, ChatGPT, Gemini) hits
  `https://<deployment>.convex.site/mcp` over Streamable HTTP MCP.
- Auth via Google OAuth (same allow-list used for the local server).
- No Channel protocol, no stdio, no UI affordances. Standard MCP tools only.

## Rules that flow from this architecture

### 1. Naming in code and comments

The words "MCP server" in this repo are ambiguous. Always disambiguate:

- "the local stdio MCP server" or "`mcp_server/`"
- "the hosted HTTP MCP server" or "`convex/mcp`" (once it exists)

When writing a file under `mcp_server/`, never refer to "the MCP server" to
mean the hosted HTTP one, and vice versa. Comments should say "the local
server" or "the HTTP server" explicitly.

### 2. Additive-only backend discipline

Because the local stdio server is published as an npm package
(`@flatoutsolutions/cccollab`) and older clients continue running in the wild,
the Convex backend must evolve additively:

- **Never rename** a Convex query, mutation, or function argument.
- **Never remove** a Convex query or mutation within two release cycles of the
  deprecation notice landing in the backend.
- **Add new fields** rather than changing existing ones.
- **Deprecate, wait, then remove.** Document the deprecation in the function's
  JSDoc and in the release notes. Remove only after at least two published
  `@flatoutsolutions/cccollab` releases have shipped without using the
  deprecated path.

This constraint applies equally to both MCP servers: the HTTP MCP server will
also be called by arbitrary external LLMs, so its tool surface must also be
backwards-stable once published.

### 3. Graceful degradation in the local server's remote transport

If the remote transport receives an authentication error, a
`FunctionNotFoundError`, or accumulates three failures within a minute:

- Log a warning to stderr (surfaced into `~/.cccollab/logs/<profile>.log`
  when the harness is configured to capture it).
- Flip the transport's `enabled` flag to `false` for the remainder of the
  session; subsequent tool calls routed to that location return a
  "degraded" error instead of dispatching.
- Keep the local broker transport (and any other remote transports)
  running normally.
- Surface the degraded state in `whoami`'s `locations` map so the user
  sees it immediately and can re-authenticate or restart.

A misbehaving backend never crashes the user's Claude Code session; at
worst, the affected remote location silently falls back and local mode
keeps working.

### 4. Where a new Convex function goes

A new Convex query or mutation **always** goes in `convex/`, never in
`mcp_server/`. Both MCP servers share the same backend. If the change is
client-only (e.g. fan-out logic, merge logic, auth token refresh), it goes in
`mcp_server/src/transport/remote.ts` or a sibling under `mcp_server/src/`.

### 5. Where a new tool goes

Tools are defined once per server, not once per repo:

- Local-stdio-specific tools live under `mcp_server/src/tools/`.
- HTTP-MCP-specific tools will live under `convex/mcp/` when that server
  exists.
- Shared semantic operations (send a message, start a topic) become Convex
  functions under `convex/`, and both servers call them.

If a tool is obviously shared (e.g. `send_message_to_topic`), its
implementation is a Convex mutation and both MCP servers expose the same tool
name to their clients.

## Why we're writing this down before the HTTP MCP server exists

Because **naming collisions are much cheaper to prevent than to unwind**. Once
code refers to "the MCP server" ambiguously and comments use that term
interchangeably between the two audiences, disentangling requires a repo-wide
rename and a careful review of every reference. Writing this rule page now -
before the HTTP server has a single file of its own - makes the distinction
load-bearing from day one.
