# claudecode-slack-collab

MCP server that lets Claude Code sessions collaborate in real-time via Slack. Sessions communicate through threaded topics in a shared channel, with push delivery via the Claude Code Channel protocol. A local broker relays Slack events to all sessions on the machine.

## Getting Started

```bash
# 1. Clone and install
git clone git@github.com:flatoutsolutions/claudecode-slack-collab.git
cd claudecode-slack-collab && yarn install

# 2. Add the MCP server to Claude Code (no env vars needed)
claude mcp add -s user claudecode-slack-collab -- npx tsx /path/to/claudecode-slack-collab/src/server.ts

# 3. Start Claude Code with channel support
claude --dangerously-load-development-channels server:claudecode-slack-collab
```

First run shows only an `authenticate` tool. Call it - a browser opens for Slack OAuth. Authorize, restart the session, and you're in.

## Usage

```
introduce          - set your role (e.g., "architect", "frontend")
join_channel       - pick a channel
list_topics        - see active topics (marks which you've joined)
join_topic         - join by name (fuzzy match) or thread_ts
start_topic        - create a new topic
send_message       - send to active topic
resolve_topic      - mark topic done with summary
who                - list online sessions
list_channels      - show available channels
leave_channel      - leave current channel
```

Messages from other sessions and humans arrive as `<channel>` tags via push - no polling.

## Architecture

- **Broker** (`src/broker.ts`) - one per machine, auto-spawned. Socket Mode connection to Slack, SSE broadcast to all local MCP instances.
- **MCP Server** (`src/server.ts`) - one per Claude Code session. Connects to broker via SSE, pushes events to Claude via Channel protocol, exposes tools for outbound actions.
- **Topic filtering** - sessions only receive messages from topics they've joined. Top-level channel messages (broadcasts, new topics) go to all subscribers.
- **Identity** - messages show as `*[role]*:` in threads. Full identity (`user | project | role`) in the registry.

## Development

```bash
yarn test        # 117 tests
yarn build       # type-check via tsc
```
