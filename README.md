# claudecode-slack-collab

MCP server that lets Claude Code sessions collaborate in real-time. Sessions communicate through threaded topics - either locally (in-process, no Slack required) or via a shared Slack channel. Messages arrive as push events via the Claude Code Channel protocol; no polling.

## Install (FlatOut Solutions team)

The package is published to GitHub Packages under the `flatoutsolutions` org. Access is restricted to org members.

**1. Create a GitHub Personal Access Token (classic)** with the `read:packages` scope and authorize it for the `flatoutsolutions` org (SSO).

**2. Configure npm** by adding to `~/.npmrc`:

```
@flatoutsolutions:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

**3. Install and register with Claude Code:**

```bash
npm i -g @flatoutsolutions/claudecode-slack-collab
claude mcp add -s user claudecode-slack-collab -- claudecode-slack-collab
```

First run exposes only an `authenticate` tool. Call it - a browser opens for Slack OAuth. Authorize, restart the session, and you're in.

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

Two env vars can be set in an MCP server definition:

| Var | Description |
|-----|-------------|
| `SLACK_PROFILE` | Selects a credentials file: `~/.config/claudecode-slack-collab/credentials-<profile>.json`. Use to run multiple Slack identities on the same machine. |
| `DEFAULT_SLACK_CHANNEL` | Auto-joins this channel on startup (strips leading `#`). Topics default to it instead of local. |

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

Publishing is automated: push a `vX.Y.Z` tag that matches the `version` in `package.json` and the GitHub Actions `Publish` workflow will run tests, build, and `npm publish` to GitHub Packages.

```bash
# bump version in package.json, commit, then:
git tag v0.1.0
git push origin v0.1.0
```
