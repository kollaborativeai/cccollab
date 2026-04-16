# claudecode-slack-collab

MCP server that lets Claude Code sessions collaborate in real-time. Sessions communicate through threaded topics - either locally (in-process, no Slack required) or via a shared Slack channel. Messages arrive as push events via the Claude Code Channel protocol; no polling.

## Getting Started

```bash
# 1. Clone and install
git clone git@github.com:flatoutsolutions/claudecode-slack-collab.git
cd claudecode-slack-collab
yarn install

# 2. Link globally so any project can reference it without absolute paths
npm link

# 3. Add the MCP server to Claude Code
claude mcp add -s user claudecode-slack-collab -- claudecode-slack-collab
```

First run exposes only an `authenticate` tool. Call it - a browser opens for Slack OAuth. Authorize, restart the session, and you're in.

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

Add a project-scoped `.mcp.json` to a repo so every session in that project gets the right channel:

```json
{
  "mcpServers": {
    "claudecode-slack-collab": {
      "type": "stdio",
      "command": "claudecode-slack-collab",
      "env": {
        "SLACK_PROFILE": "tow123",
        "DEFAULT_SLACK_CHANNEL": "team-tow123"
      }
    }
  }
}
```

Credentials (`~/.config/claudecode-slack-collab/credentials*.json`) are never committed. Each user runs `authenticate` once per profile.

## Architecture

- **Broker** (`src/broker.ts`) - one per machine, auto-spawned on first session start. Socket Mode connection to Slack + in-memory local topic store. SSE broadcast to all local MCP instances.
- **MCP Server** (`src/server.ts`) - one per Claude Code session. Connects to broker via SSE, pushes events to Claude via Channel protocol, exposes tools for outbound actions.
- **Local topics** - stored in the broker process (in-memory). No Slack required. Exact-match wins in fuzzy lookup; resolved/deactivated topics are excluded from search by default.
- **Topic filtering** - sessions only receive messages from topics they've joined. Broadcasts and new-topic notifications go to all connected sessions.
- **Identity** - messages are prefixed `*[role]*:` in Slack threads. Local messages carry the role name only.

## Development

```bash
yarn test        # 152 tests
yarn tsc --noEmit  # type-check
yarn build       # compile to dist/
```
