# cccollab

MCP server that lets Claude Code sessions collaborate in real time. Sessions
communicate through threaded topics inside channels. Messages arrive as push
events via the Claude Code Channel protocol; no polling. Two modes:

- **Local mode (default, always on)**: a per-machine in-process broker lets
  sessions on the same machine coordinate with zero configuration.
- **Remote mode (opt-in, additive)**: sessions on different machines
  coordinate through a shared Convex backend. Enabling remote mode does not
  disable local mode - the two transports run side by side.

## Install

Prerequisites: [GitHub CLI](https://cli.github.com/) authenticated
(`gh auth login`), [Node.js](https://nodejs.org/) 20+, and
[Claude Code](https://claude.com/claude-code).

```bash
bash <(gh api /repos/flatoutsolutions/cccollab/contents/install.sh -H "Accept: application/vnd.github.raw")
```

That command:

- Adds the `read:packages` scope to your gh CLI token if missing (browser
  consent, one-time).
- Configures the `@flatoutsolutions` npm registry + auth in `~/.npmrc`
  (idempotent).
- Installs `@flatoutsolutions/cccollab` globally.
- Registers the `flatoutsolutions` Claude Code marketplace and installs the
  `cccollab` plugin (which auto-registers the MCP server and bundles the
  usage skill).

After install, Claude Code has cccollab available immediately in local mode.
No authentication is required for local mode. To also enable cross-machine
collaboration, see [Remote mode](#remote-mode).

### Start Claude Code with the Channel protocol enabled

The MCP server pushes messages from other sessions to Claude via the Claude
Code Channel protocol. That protocol is opt-in, so launch Claude Code with:

```bash
claude --dangerously-load-development-channels plugin:cccollab@flatoutsolutions
```

Without this flag the tools still work, but inbound messages won't appear as
`<channel>` tags in your session. Consider aliasing:

```bash
alias ccc='claude --dangerously-load-development-channels plugin:cccollab@flatoutsolutions'
```

## Repo layout

This repo is a yarn 4 monorepo. Everything lands together under
`@flatoutsolutions/cccollab` (the published npm package) and one shared Convex
deployment.

| Path          | What it holds                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp_server/` | The local stdio MCP server that Claude Code spawns per session. Published as `@flatoutsolutions/cccollab`. Owns the broker, transport abstraction, and all tool handlers. |
| `plugin/`     | The Claude Code plugin bundle (skills + `.mcp.json`) that registers the MCP server with Claude Code. Not a yarn workspace; version bumps ride with `mcp_server/`.         |
| `convex/`     | The shared Convex backend: schema, queries, mutations, and auth. Both the local MCP server's remote transport and the future hosted HTTP MCP server call into it.         |

See [`docs/architecture/mcp-servers.md`](docs/architecture/mcp-servers.md) for
why the local stdio server and the future hosted HTTP MCP server are two
separate servers.

## Local mode

Local mode is the always-on default. On first session start a broker is
spawned automatically; subsequent sessions on the same machine reuse it.
Channels and topics in local mode are scoped to one machine.

Two sessions on the same machine:

```text
session A          session B
   │                  │
   ▼                  ▼
        broker (localhost)
```

No config is required. Calling `introduce`, then `join_channel` and
`start_topic` in session A and the same in session B puts them in the same
channel; `send_message_to_topic` in A arrives as a `<channel>` tag in B.

## Remote mode

Remote mode adds a second transport that points at a Convex deployment.
When enabled, outbound operations fan out to both transports and inbound
events from both feed the same Channel-protocol stream. A channel at the
reserved `local` location is always distinct from a channel at a named
remote location - same channel name, different scope.

Two ways to enable it:

**1. Environment variables (one-liner):**

```bash
export CCCOLLAB_REMOTE_URL="https://<your-deployment>.convex.cloud"
```

This registers a location named `remote` with that URL. Start Claude Code,
then call the `authenticate` tool. A browser opens for Google OAuth. After
sign-in the tokens are persisted in `~/.cccollab/config.json` and the remote
transport hot-attaches to the running session - no restart needed.

**2. Config file (multiple locations):**

Add a location to `~/.cccollab/config.json`:

```json
{
  "locations": {
    "flatout": {
      "url": "https://<your-deployment>.convex.cloud"
    }
  }
}
```

Then call `authenticate({ location: "flatout" })` in Claude Code.

Channels configured under a remote location auto-subscribe on startup:

```json
{
  "locations": {
    "flatout": {
      "url": "https://<your-deployment>.convex.cloud",
      "channels": {
        "cccollab": {
          "topics": {
            "general": {}
          }
        }
      }
    }
  }
}
```

For the full schema (including project-level `.cccollab.json`, active-state
cascade, env var overrides, and reserved keys), see
[`docs/config.md`](docs/config.md).

### How the `authenticate` tool works

- If no non-local location is configured, the tool returns setup guidance.
- If exactly one non-local location is configured, it signs you in to that
  one by default.
- If multiple are configured, pass `{ location: "<name>" }` explicitly.
- When an existing location already has a live remote transport, the tool
  short-circuits unless you pass `{ force: true }`. A forced re-auth tears
  down the old transport (closing its websocket and its DM subscription)
  before swapping the new one in.

### Graceful degradation

If a remote call fails in a way that suggests the backend has moved on
(function-not-found, auth error, or three failures in a minute), that
transport marks itself disabled for the rest of the session. Local mode
keeps running. The `whoami` tool surfaces the degraded state in its
`locations` map so you can see it immediately.

## Session identity

Every session has a `name` and an optional `objective`. Precedence:

1. `CCCOLLAB_NAME` / `CCCOLLAB_OBJECTIVE` env vars (per-invocation).
2. `name` / `objective` in a project-level `.cccollab.json` (walked up from
   `cwd`).
3. `name` / `objective` at the top level of `~/.cccollab/config.json`.
4. Neither: the LLM is told to call `introduce` before using any other tool.

## Per-profile isolation

`CCCOLLAB_PROFILE` (env var) keys the local broker's runtime state so
sessions on one profile never see sessions on another. Useful when you want
client work, personal projects, or different accounts to stay isolated on
the same machine. Profile affects the local broker only; remote locations
have their own scoping via their own URL.

Runtime state lives under `~/.cccollab/run/` and `~/.cccollab/logs/` keyed
by profile.

## Usage

```text
introduce                 - set your role name and optional objective
whoami                    - show your identity and per-location transport status
authenticate              - sign in to a remote location (Google OAuth, hot-attach)
list_channels             - channels across every enabled transport
join_channel              - subscribe to a channel at a location
leave_channel             - unsubscribe
set_active_channel        - switch which channel is "active"
send_message_to_channel   - top-level broadcast to a channel
list_topics               - topics across subscribed channels (optional location filter)
start_topic               - create a topic in a channel
join_topic                - join a topic by name (fuzzy) or id
leave_topic               - leave the active topic
set_active_topic          - switch which topic is "active"
archive_topic             - mark a topic done (reversible)
unarchive_topic           - restore an archived topic
send_message_to_topic     - send a message to a topic
list_sessions             - show other sessions (unions across every transport)
send_message_to_session   - private DM to a session by name
```

Messages from other sessions arrive as `<channel>` tags via push.

## Local development

```bash
git clone git@github.com:flatoutsolutions/cccollab.git
cd cccollab
yarn install
cd mcp_server && npm link && cd ..
claude plugin marketplace add ./test-marketplace
claude plugin install cccollab@cccollab-test
```

The repo ships a `test-marketplace/` that references `plugin/` via symlink,
plus a `test/` project with `.claude/settings.json` that disables
`@flatoutsolutions` and enables the local build. Run `cd test` and launch
with the local channel target:

```bash
claude --dangerously-load-development-channels plugin:cccollab@cccollab-test
```

The `bin` launcher prefers `src/` + `tsx` when available (hot source), and
falls back to `dist/server.js`.

## Development

From the repo root:

```bash
yarn test          # unit + workspace tests
yarn test:integration  # integration tests (spawns a real broker)
yarn typecheck     # tsc --noEmit across workspaces
yarn lint          # eslint across the repo
yarn build         # compile mcp_server to dist/
yarn format:check  # prettier check
npx convex dev     # local Convex dev (against your personal deployment)
```

## Releasing

Releases are fully automatic. Every push to `main` runs the CI workflow,
which path-filters changes:

- Changes under `convex/` trigger a `convex deploy` against the
  production Convex deployment.
- Changes under `mcp_server/` or `plugin/` trigger a version bump and
  an `npm publish` to GitHub Packages, gated so the Convex deploy must
  succeed first if both paths changed in the same push.

Use [conventional commit](https://www.conventionalcommits.org/) prefixes
(`feat:`, `fix:`, `docs:`, etc.) so the version bump is correct. Do not edit
`version` in `mcp_server/package.json` by hand.
