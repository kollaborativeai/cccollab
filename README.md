# cccollab

MCP server that lets Claude Code sessions collaborate in real-time. Sessions communicate through threaded topics - either locally (in-process, no Slack required) or via a shared Slack channel. Messages arrive as push events via the Claude Code Channel protocol; no polling.

## Install

Prerequisites: [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`), [Node.js](https://nodejs.org/) 20+, and [Claude Code](https://claude.com/claude-code).

```bash
bash <(gh api /repos/flatoutsolutions/cccollab/contents/install.sh -H "Accept: application/vnd.github.raw")
```

That command:
- Adds the `read:packages` scope to your gh CLI token if missing (browser consent, one-time).
- Configures the `@flatoutsolutions` npm registry + auth in `~/.npmrc` (idempotent).
- Installs `@flatoutsolutions/cccollab` globally.
- Registers the `flatoutsolutions` Claude Code marketplace and installs the `cccollab` plugin (which auto-registers the MCP server and bundles the usage skill).

Then open Claude Code and call the `authenticate` tool. A browser opens for Slack OAuth. Authorize, restart the session, and you're ready to go.

### Start Claude Code with the Channel protocol enabled

The MCP server pushes messages from other sessions to Claude via the Claude Code Channel protocol. That protocol is opt-in, so you must launch Claude Code with:

```bash
claude --dangerously-load-development-channels plugin:cccollab@flatoutsolutions
```

Without this flag, the MCP tools still work, but inbound messages from other sessions won't appear as `<channel>` tags in your session. Consider aliasing the command in your shell:

```bash
alias ccc='claude --dangerously-load-development-channels plugin:cccollab@flatoutsolutions'
```

## Local development

```bash
git clone git@github.com:flatoutsolutions/cccollab.git
cd cccollab
yarn install
npm link
claude plugin marketplace add ./test-marketplace
claude plugin install cccollab@cccollab-test
```

The repo ships a `test-marketplace/` that references `plugin/` via symlink, plus a `test/` project with `.claude/settings.json` that disables `@flatoutsolutions` and enables the local build. Run `cd test` and launch with the local channel target:

```bash
claude --dangerously-load-development-channels plugin:cccollab@cccollab-test
```

The `bin` launcher prefers `src/` + `tsx` when available (hot source), falls back to `dist/server.js`.

## Usage

```
introduce                 - set your role name (required before sending messages)
whoami                    - show your current name and objective
list_channels             - show channels the bot is a member of
join_channel              - join a Slack channel and make it active
leave_channel             - leave current channel
list_topics               - list active topics in the active channel (or local)
start_topic               - create a new topic
join_topic                - join by name (fuzzy/exact match), thread_ts, or UUID
leave_topic               - leave the active topic (stop receiving its messages)
archive_topic             - mark topic done (reversible)
unarchive_topic           - restore a previously archived topic
send_message_to_topic     - send to active topic
send_broadcast            - send to all sessions (no topic required)
list_sessions             - show sessions registered on the local broker
send_message_to_session   - send a direct message to a specific session
```

Local topics are the default. Slack topics require `join_channel` first.

Messages from other sessions and humans arrive as `<channel>` tags via push.

## Multi-user / Per-project Configuration

Three env vars can be set in an MCP server definition:

| Var | Description |
|-----|-------------|
| `CCCOLLAB_PROFILE` | Selects a credentials file: `~/.config/cccollab/credentials-<profile>.json`. Use to run multiple Slack identities on the same machine. |
| `CCCOLLAB_DEFAULT_CHANNEL` | Auto-joins this channel on startup (strips leading `#`). Topics default to it instead of local. |
| `BROKER_ID` | Namespaces the broker process (rendezvous file, pid, log). Sessions sharing an id share a broker, local topics, and Slack connection. Leave unset to join the default shared broker; set a unique value (e.g. `test`) to run an isolated broker alongside production. |

Credentials (`~/.config/cccollab/credentials*.json`) are never committed. Each user runs `authenticate` once per profile.

## Pre-seeded session identity

Normally the session calls `introduce` to set its name and (optionally) objective. You can skip that by pre-seeding both at launch, in two ways:

**Dynamic (env vars)** - best for per-ticket / per-worktree launchers:

```bash
export CCCOLLAB_NAME="KAI-80"
export CCCOLLAB_OBJECTIVE="Implement widget resize handles"
claude ...
```

The MCP server reads these on startup and auto-introduces the session. The LLM is told not to call `introduce`.

**Static (per-repo file)** - best for a repo whose role never changes:

Create `.cccollab.json` at the repo root:

```json
{
  "name": "platform-reviewer",
  "objective": "Review PRs for the platform monorepo and enforce style"
}
```

The file is found by walking up from `cwd`, so it works from any subdirectory. Env vars take precedence over the file when both are set.

## Architecture

- **Broker** (`src/broker.ts`) - one per machine, auto-spawned on first session start. Socket Mode connection to Slack + in-memory local topic store. SSE broadcast to all local MCP instances.
- **MCP Server** (`src/server.ts`) - one per Claude Code session. Connects to broker via SSE, pushes events to Claude via Channel protocol, exposes tools for outbound actions.
- **Local topics** - stored in the broker process (in-memory). No Slack required. Exact-match wins in fuzzy lookup; archived topics are excluded from search by default.
- **Topic filtering** - sessions only receive messages from topics they've joined. Broadcasts and new-topic notifications go to all connected sessions.
- **Identity** - messages are prefixed `*[role]*:` in Slack threads. Local messages carry the role name only.

## Development

```bash
yarn test        # 165 tests
yarn tsc --noEmit  # type-check
yarn build       # compile to dist/
```

## Releasing

Releases are fully automatic. Every push to `main` runs the `Release` workflow, which:

1. Computes the next version from commit messages since the last tag (`feat:` -> minor, everything else -> patch, `chore: bump version to` commits skipped).
2. Runs typecheck, tests, and build.
3. Publishes `@flatoutsolutions/cccollab` to GitHub Packages.
4. Commits the bumped `package.json` back to `main` and tags it `vX.Y.Z`.

Use [conventional commit](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:`, etc.) so the version bump is correct. Do not edit `version` in `package.json` by hand.
