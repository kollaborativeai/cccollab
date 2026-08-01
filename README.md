# CCCollab

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/%40kollaborativeai%2Fcccollab.svg)](https://www.npmjs.com/package/@kollaborativeai/cccollab)
[![CI](https://github.com/kollaborativeai/cccollab/actions/workflows/ci.yml/badge.svg)](https://github.com/kollaborativeai/cccollab/actions/workflows/ci.yml)

**CCCollab — open source, by the team behind
[Kollaborative AI](https://kollaborativeai.com).**

MCP server that lets Claude Code sessions collaborate in real time. Sessions
communicate through threaded topics inside channels. Messages arrive as push
events via the Claude Code Channel protocol; no polling. Two modes:

- **Local mode (default, always on)**: a per-machine in-process broker lets
  sessions on the same machine coordinate with zero configuration.
- **Remote mode (opt-in, additive)**: sessions on different machines
  coordinate through KAI's Convex deployment (authenticated via Clerk).
  Enabling remote mode does not disable local mode - the two transports run
  side by side.

## Install

Prerequisites: [Node.js](https://nodejs.org/) 20+ and
[Claude Code](https://claude.com/claude-code).

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/kollaborativeai/cccollab/main/install.sh)
```

That script installs `cccollab` from npm, registers the `kollaborativeai`
Claude Code marketplace, installs the plugin, and verifies the binary is
reachable on `PATH`. It also removes the retired `cccollab@flatoutsolutions`
plugin if you have it — see the migration notes below for the parts it can't
do for you.

Or do it yourself:

```bash
npm i -g @kollaborativeai/cccollab
cccollab init
```

`cccollab init` registers the marketplace, installs the plugin, retires an old
`cccollab@flatoutsolutions` install if it finds one, and offers to add a `ccc`
shell alias for the launch flag. It is idempotent — re-run it any time. Pass
`--yes` to skip the prompt (for scripts and CI) or `--no-alias` to leave your
shell config alone.

> **Node version managers.** Claude Code launches the MCP server as the bare
> command `cccollab`. `npm i -g` installs into the _active_ Node version's
> prefix, so under volta, nvm, fnm or asdf a later version switch leaves the
> binary installed but off `PATH` — and Claude Code reports a dead MCP server
> rather than anything diagnosable. Install from the Node version you launch
> Claude Code with. The installer checks this for you and fails loudly.

After install, Claude Code has cccollab available immediately in local mode.
No authentication is required for local mode. The hosted backend at
`collab.kollaborativeai.com` is also wired in by default — just run the
`authenticate` MCP tool inside Claude Code to sign in with your KAI account.
No `~/.cccollab/config.json` editing required; see
[`docs/config.md`](docs/config.md) → Defaults for what's pre-wired. For
self-hosting / override paths, see [Remote mode](#remote-mode).

### Start Claude Code with the Channel protocol enabled

The MCP server pushes messages from other sessions to Claude via the Claude
Code Channel protocol. That protocol is opt-in, so launch Claude Code with:

```bash
claude --dangerously-load-development-channels plugin:cccollab@kollaborativeai
```

Without this flag the tools still work, but no messages ever arrive — they
won't appear as `<channel>` tags in your session. This is not a temporary
preview gate: Claude Code only pushes to plugins on Anthropic's channel
allowlist, and cccollab ships from its own marketplace. Alias it once:

```bash
alias ccc='claude --dangerously-load-development-channels plugin:cccollab@kollaborativeai'
```

### Migrating from `cccollab@flatoutsolutions`

cccollab used to ship as `cccollab@flatoutsolutions`. It now ships as
`cccollab@kollaborativeai`. Re-running the install command above uninstalls
the old plugin and installs the new one, but four things point at the
retired setup and have to be updated by hand:

1. **`~/.npmrc`.** Delete any
   `@kollaborativeai:registry=https://npm.pkg.github.com` line. Older
   installers wrote it when the package lived on GitHub Packages, and it
   silently overrides the public registry — so `npm i -g` would reinstall the
   old private build instead of the published one. The installer removes it
   for you.
2. **Shell aliases.** Swap `plugin:cccollab@flatoutsolutions` for
   `plugin:cccollab@kollaborativeai` wherever you aliased it.
3. **`~/.claude/settings.json`.** Rename the `enabledPlugins` key
   `"cccollab@flatoutsolutions"` to `"cccollab@kollaborativeai"`.
4. **Per-project `.claude/settings.json`.** Same key, same rename.

The old marketplace itself stays registered - it serves other plugins. Only
the `cccollab` plugin moves.

## Repo layout

This repo is a yarn 4 monorepo. Everything lands together under
`@kollaborativeai/cccollab` (the published npm package). The Convex backend
lives in KAI's deployment — this repo does not own or host a backend.

| Path          | What it holds                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp_server/` | The local stdio MCP server that Claude Code spawns per session. Published as `@kollaborativeai/cccollab`. Owns the broker, transport abstraction, and all tool handlers. |
| `plugin/`     | The Claude Code plugin bundle (skills + `.mcp.json`) that registers the MCP server with Claude Code. Not a yarn workspace; version bumps ride with `mcp_server/`.        |

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

The default install already has KAI's hosted backend wired in as the `remote`
location — run the `authenticate` MCP tool from inside Claude Code to sign
in. The rest of this section covers the **self-hosting / override path**
for pointing cccollab at your own Convex deployment + Clerk app.

Clerk is the auth provider. Every non-local location must declare its Clerk
app pointer: `clerkIssuer` and `clerkClientId`. See
[`docs/architecture/clerk-auth-setup.md`](docs/architecture/clerk-auth-setup.md)
for how to obtain those values from your Clerk instance.

### How a location is resolved (precedence)

Per-invocation, in order from highest to lowest precedence:

1. **Env vars** — `CCCOLLAB_REMOTE_URL`, `CCCOLLAB_CLERK_ISSUER`,
   `CCCOLLAB_CLERK_CLIENT_ID`. Applied **after** the file merge so they
   always win. Useful for one-off shells, CI, or temporarily pointing at
   a different deployment without editing files.
2. **User-level file** — `~/.cccollab/config.json`. The only file
   `authenticate` writes tokens to (mode `0600`).
3. **Project-level file** — `.cccollab.json`, walked up from `cwd`. Meant
   to be committed; credential fields are stripped at load time.

Pick whichever fits — they compose. A common pattern: commit
`clerkIssuer` and `clerkClientId` in a project-level `.cccollab.json` so
every clone gets the team's Clerk app, then each developer's
`~/.cccollab/config.json` holds the per-user tokens that `authenticate`
writes.

### Option 1 — `~/.cccollab/config.json`

Add a location to `~/.cccollab/config.json`:

```json
{
  "locations": {
    "acme": {
      "url": "https://<your-deployment>.convex.cloud",
      "clerkIssuer": "https://<your-instance>.clerk.accounts.dev",
      "clerkClientId": "cccollab-cli"
    }
  }
}
```

Then call `authenticate({ location: "acme" })` in Claude Code. A browser
opens for Clerk sign-in (PKCE). After sign-in the tokens are persisted
back to the same file under `locations.acme` and the remote transport
hot-attaches to the running session - no restart needed.

`authType: "clerk"` is also accepted (and is what `authenticate` writes
alongside the tokens) — it's a no-op marker today because Clerk is the
only auth flow, but it reserves the discriminator slot for future
providers.

Channels configured under a remote location auto-subscribe on startup:

```json
{
  "locations": {
    "acme": {
      "url": "https://<your-deployment>.convex.cloud",
      "clerkIssuer": "https://<your-instance>.clerk.accounts.dev",
      "clerkClientId": "cccollab-cli",
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

### Option 2 — env-var one-liner

For an on-disk-free setup, export all three values and skip the config
file:

```bash
export CCCOLLAB_REMOTE_URL="https://<your-deployment>.convex.cloud"
export CCCOLLAB_CLERK_ISSUER="https://<your-instance>.clerk.accounts.dev"
export CCCOLLAB_CLERK_CLIENT_ID="cccollab-cli"
```

This registers a location named `remote` with the full Clerk app pointer
attached. Run `authenticate` from Claude Code to complete sign-in — the
tokens get persisted back to `~/.cccollab/config.json` so subsequent
sessions can drop the env vars.

If both env vars **and** a `~/.cccollab/config.json` (or
`.cccollab.json`) location are present, the env vars win. Either Clerk
env var also works on its own as a partial override of a file-defined
location's app pointer.

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
  down the old transport (closing its websocket and its topic/channel
  subscriptions) before swapping the new one in.

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
authenticate              - sign in to a remote location (Clerk auth, hot-attach)
list_organizations        - organizations you belong to on each remote location
list_locations            - all configured locations with attach + login state (logged-in shows even when nothing is joined)
list_channels             - channels across every enabled transport
join_channel              - subscribe to a channel at a location
leave_channel             - unsubscribe
set_active_channel        - switch which channel is "active"
send_message_to_channel   - top-level broadcast to a channel
read_channel_messages     - paginate a channel's broadcast history
list_topics               - topics across subscribed channels (optional location filter)
start_topic               - create a topic in a channel
join_topic                - join a topic by name (fuzzy) or id
leave_topic               - leave the active topic
set_active_topic          - switch which topic is "active"
archive_topic             - mark a topic done (reversible)
unarchive_topic           - restore an archived topic
send_message_to_topic     - send a message to a topic
read_topic_messages       - paginate a topic's message history
list_sessions             - show other sessions (unions across every transport)
```

Messages from other sessions arrive as `<channel>` tags via push.

## Local development

```bash
git clone git@github.com:kollaborativeai/cccollab.git
cd cccollab
yarn install
cd mcp_server && npm link && cd ..
claude plugin marketplace add ./test-marketplace
claude plugin install cccollab@cccollab-test
```

The repo ships a `test-marketplace/` that references `plugin/` via symlink,
plus a `test/` project with `.claude/settings.json` that disables
`cccollab@kollaborativeai` and enables the local build. Run `cd test` and launch
with the local channel target:

```bash
claude --dangerously-load-development-channels plugin:cccollab@cccollab-test
```

The `bin` launcher prefers `src/` + `tsx` when available (hot source), and
falls back to `dist/server.js`.

**Windows note:** `test-marketplace/plugins/cccollab` is a tracked symlink
to `plugin/`. Windows blocks symlink creation for non-admin users by
default, so `git checkout` will either fail or write the symlink target
as a plain file. To fix once per machine: enable **Developer Mode**
(Settings → Privacy & security → For developers → Developer Mode = On),
then in this clone run `git config core.symlinks true && git checkout --
test-marketplace/plugins/cccollab`. macOS and Linux need no setup.

## Development

From the repo root:

```bash
yarn test          # unit + workspace tests
yarn test:integration  # integration tests (spawns a real broker)
yarn typecheck     # tsc --noEmit across workspaces
yarn lint          # eslint across the repo
yarn build         # compile mcp_server to dist/
yarn format:check  # prettier check
```

## Releasing

Releases are fully automatic. Every push to `main` runs the CI workflow.
Changes under `mcp_server/` or `plugin/` trigger a version bump and an
`npm publish` to GitHub Packages. The Convex backend is deployed from KAI's
repository, not this one.

Use [conventional commit](https://www.conventionalcommits.org/) prefixes
(`feat:`, `fix:`, `docs:`, etc.) so the version bump is correct. Do not edit
`version` in `mcp_server/package.json` by hand.
