# claudecode-slack-collab

MCP server that lets Claude Code sessions collaborate in real-time. Sessions communicate through threaded topics - either locally (in-process, no Slack required) or via a shared Slack channel. Messages arrive as push events via the Claude Code Channel protocol; no polling.

## Install

Prerequisite: [GitHub CLI](https://cli.github.com/) authenticated (`gh auth login`).

```bash
gh auth refresh -s read:packages && \
  { echo "@flatoutsolutions:registry=https://npm.pkg.github.com"; \
    echo "//npm.pkg.github.com/:_authToken=$(gh auth token)"; } >> ~/.npmrc && \
  npm i -g @flatoutsolutions/claudecode-slack-collab && \
  claude mcp add -s user claudecode-slack-collab -- claudecode-slack-collab
```

What this does:
- Adds the `read:packages` scope to your gh CLI token (browser consent, one-time).
- Appends the `@flatoutsolutions` registry + auth token to `~/.npmrc`.
- Installs the CLI globally via npm.
- Registers it as an MCP server with Claude Code.

First run of the MCP server in Claude Code exposes only an `authenticate` tool. Call it - a browser opens for Slack OAuth. Authorize, restart the session, and you're in.

### Optional: install the plugin

The `claudecode-slack-collab` Claude Code plugin (on the `flatoutsolutions` marketplace) bundles a usage skill and auto-registers the MCP server, so you can skip the `claude mcp add` step:

```
/plugin install claudecode-slack-collab@flatoutsolutions
```

The npm package still needs to be on PATH - run the install command above first.

## Local development

```bash
git clone git@github.com:flatoutsolutions/claudecode-slack-collab.git
cd claudecode-slack-collab
yarn install
npm link
claude mcp add -s user claudecode-slack-collab -- claudecode-slack-collab
```

The `bin` launcher prefers `src/` + `tsx` when available (hot source), falls back to `dist/server.js`.

## Usage

```
introduce          - set your role name (required before sending messages)
list_channels      - show channels the bot is a member of
join_channel       - join a Slack channel and make it active
leave_channel      - leave current channel
list_topics        - list active topics in the active channel (or local)
start_topic        - create a new topic
join_topic         - join by name (fuzzy/exact match), thread_ts, or UUID
send_message       - send to active topic
send_broadcast     - send to all sessions (no topic required)
resolve_topic      - mark topic done with a summary
deactivate_topic   - pause a topic without resolving it
activate_topic     - reactivate a deactivated topic
```

Local topics are the default. Slack topics require `join_channel` first.

Messages from other sessions and humans arrive as `<channel>` tags via push.

## Multi-user / Per-project Configuration

Three env vars can be set in an MCP server definition:

| Var | Description |
|-----|-------------|
| `SLACK_PROFILE` | Selects a credentials file: `~/.config/claudecode-slack-collab/credentials-<profile>.json`. Use to run multiple Slack identities on the same machine. |
| `DEFAULT_SLACK_CHANNEL` | Auto-joins this channel on startup (strips leading `#`). Topics default to it instead of local. |
| `BROKER_ID` | Namespaces the broker process (rendezvous file, pid, log). Sessions sharing an id share a broker, local topics, and Slack connection. Leave unset to join the default shared broker; set a unique value (e.g. `test`) to run an isolated broker alongside production. |

Credentials (`~/.config/claudecode-slack-collab/credentials*.json`) are never committed. Each user runs `authenticate` once per profile.

## Architecture

- **Broker** (`src/broker.ts`) - one per machine, auto-spawned on first session start. Socket Mode connection to Slack + in-memory local topic store. SSE broadcast to all local MCP instances.
- **MCP Server** (`src/server.ts`) - one per Claude Code session. Connects to broker via SSE, pushes events to Claude via Channel protocol, exposes tools for outbound actions.
- **Local topics** - stored in the broker process (in-memory). No Slack required. Exact-match wins in fuzzy lookup; resolved/deactivated topics are excluded from search by default.
- **Topic filtering** - sessions only receive messages from topics they've joined. Broadcasts and new-topic notifications go to all connected sessions.
- **Identity** - messages are prefixed `*[role]*:` in Slack threads. Local messages carry the role name only.

## Development

```bash
yarn test        # 155 tests
yarn tsc --noEmit  # type-check
yarn build       # compile to dist/
```

## Releasing

Releases are fully automatic. Every push to `main` runs the `Release` workflow, which:

1. Computes the next version from commit messages since the last tag (`feat:` -> minor, everything else -> patch, `chore: bump version to` commits skipped).
2. Runs typecheck, tests, and build.
3. Publishes `@flatoutsolutions/claudecode-slack-collab` to GitHub Packages.
4. Commits the bumped `package.json` back to `main` and tags it `vX.Y.Z`.

Use [conventional commit](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:`, etc.) so the version bump is correct. Do not edit `version` in `package.json` by hand.
