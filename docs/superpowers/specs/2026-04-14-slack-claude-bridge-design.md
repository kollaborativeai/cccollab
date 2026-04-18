# Slack Claude Bridge - Design Spec

**Epic:** IRD-46
**Repo:** https://github.com/flatoutsolutions/cccollab
**Date:** 2026-04-14

## Problem

Claude Code sessions on different machines cannot communicate. The existing claude-peers MCP server only works locally on a single machine. Teams need cross-machine, cross-network collaboration between Claude Code sessions, with humans as first-class participants.

## Solution

An MCP server that uses Slack as the transport layer for real-time agent collaboration. Each developer's Claude Code session runs a local MCP server that connects to Slack via Socket Mode (WebSocket). Messages are pushed directly into Claude Code sessions via the Channel protocol. Outbound actions use MCP tools.

This replaces claude-peers as the sole inter-agent communication system.

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Transport | Slack Socket Mode (inbound) + Web API (outbound) | Zero polling, zero deployed infrastructure, event-driven |
| Delivery model | Claude Code Channel protocol (push-first) | Messages arrive without tool calls; tools for outbound only |
| Slack app model | Single shared bot ("Claude Bridge") per workspace | Simple, no per-developer app management, session identity via message prefix |
| Authentication | Bot Token (xoxb) + App-Level Token (xapp) | Both stay local on each dev's machine; xapp required for Socket Mode |
| Channel model | One Slack channel per team, threads for conversations | No channel sprawl; threads are free, instant, unlimited |
| Session identity | `*[SESSION_NAME]*:` prefix in messages | AI clearly identifiable as AI; humans look like humans |
| Session naming | `USERNAME-REPO-WORKTREE`, auto-derived, overridable at runtime | Unique by default, human-readable, flexible |
| Technology | Node.js + TypeScript, MCP SDK, Slack SDK, zod | Standard stack, ES Modules, ES2022, runs via npx tsx |
| Multi-workspace | Single workspace for v1 | Architecture clean for future expansion - no hardcoded single-workspace assumptions |
| Official Slack MCP | Coexists independently | Official Slack MCP is user's personal assistant; this is agent collaboration layer |
| Wait-for tools | None | Channel push eliminates the need; no polling, no wait loops |

## System Architecture

```
Developer's Machine

  Claude Code Session <--stdio--> MCP Server (slack-collab)
       ^                              |
       |  <channel> tags              |-- SessionManager
       |  (push inbound)              |-- SubscriptionManager
       |                              |-- MessageBus
       |  MCP tools                   |-- SocketModeListener
       |  (outbound actions)          |
       v                              v
                                  Slack API (WebSocket)
```

### Data Flow - Inbound Message

1. Slack pushes event via WebSocket to Socket Mode client
2. Socket Mode listener acks immediately
3. SubscriptionManager filters - drop if channel not subscribed
4. Filter out self-messages (session name matches own name)
5. Parse session identity from message prefix
6. MessageBus receives parsed message
7. Channel notification pushes to Claude Code session as `<channel>` tag

### Data Flow - Outbound Message

1. Claude calls MCP tool (e.g., `reply_in_conversation`)
2. Tool formats message with `*[SESSION_NAME]*:` prefix
3. Slack Web API `chat.postMessage` sends to the thread

### What Claude Sees (Inbound)

```
<channel source="slack-collab" sender="carlos-backend" channel="team-alpha-collab" thread_ts="1234567890.123456">
I've finished the auth module. Can someone review the token refresh logic?
</channel>
```

## Core Components

### Server (server.ts)

Entry point. Creates the MCP Server with Channel capability, registers all tools, wires components together, connects via stdio transport.

```ts
const mcp = new Server(
  { name: 'slack-collab', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: '...',
  },
)
```

### SessionManager (session.ts)

Manages this session's identity. Auto-derives session name from `USERNAME` env var + git repo name + worktree suffix. Handles registry channel announcements and status updates. Provides the `fmt()` function for prefixing outbound messages and `parse()` for extracting identity from inbound messages.

- `USERNAME` env var is required (from MCP config)
- Repo name detected from `PWD` (best-effort, falls back to `USERNAME-unknown`)
- Worktree suffix detected from git (best-effort)
- Override via `announce_session` name parameter

### SubscriptionManager (subscriptions.ts)

Local subscription filter. Two-level model:
- **Slack-level:** Bot is a member of channels (shared across all sessions)
- **Local-level:** This session's `Set<string>` of channel IDs it cares about

Key methods:
- `join(channelName)` - calls `conversations.join` (idempotent) + adds to local set
- `leave(channelId)` - removes from local set only (does NOT remove bot from Slack)
- `isSubscribed(channelId)` - `Set.has()` lookup, hot path, called for every WebSocket event
- Channel name-to-ID cache (`Map<string, string>`) to avoid repeated API lookups

### SocketModeListener (socket-listener.ts)

Bridges Slack's WebSocket to the rest of the system. On every incoming event:
1. `ack()` immediately
2. Filter subtypes (channel_join, bot_message, etc.)
3. `isSubscribed()` check - drop unsubscribed channels with zero processing
4. Parse session identity
5. Filter self-messages
6. Dual routing: emit on `channel:{channelId}` always, additionally on `thread:{thread_ts}` if present
7. Push to Claude via Channel notification

### MessageBus (message-bus.ts)

Thin pass-through in v1. Receives parsed messages from Socket Mode, emits to event keys, triggers Channel notification. No ring buffer in v1 - Slack is the source of truth for history. Can add local buffering later if performance demands it.

## MCP Tools (11 total)

### Session Management (3)

**announce_session**
- Register in the `#ai-collab-registry` channel
- Posts: `:robot_face: *[SESSION_NAME]* online | Role: {role} | Status: {status}`
- Parameters: `role` (required), `status` (optional), `name_override` (optional)

**list_sessions**
- Reads registry channel, de-duplicates by session name (keeps most recent)
- Returns: session name, role, status, last seen timestamp

**set_status**
- Updates this session's status in the registry
- Parameters: `status` (required)

### Channel Subscriptions (3)

**subscribe_channel**
- Joins Slack channel + starts receiving pushed events
- Optionally reads recent history on first subscribe
- Announces presence in the channel
- Parameters: `channel` (required), `read_history` (optional, default true)

**unsubscribe_channel**
- Stops receiving events from a channel (local filter only)
- Optionally posts departure message
- Parameters: `channel` (required), `post_departure` (optional, default true)

**list_subscriptions**
- Returns all channels this session is subscribed to with human-readable names

### Conversations (5)

**start_conversation**
- Posts a top-level message in a team channel, creating a new thread
- Format includes topic, detail, participants needed
- Returns `thread_ts` (conversation ID) for others to join
- Parameters: `channel` (required), `topic` (required), `detail` (optional), `participants_needed` (optional)

**join_conversation**
- Fetches full thread history via `conversations.replies`
- Announces presence in the thread
- Returns conversation context so Claude gets up to speed
- Parameters: `channel` (required), `thread_ts` (required)

**reply_in_conversation**
- Posts a reply to an existing thread, auto-tagged with session identity
- Parameters: `channel` (required), `thread_ts` (required), `text` (required)

**list_conversations**
- Lists active/resolved conversations in a channel
- Returns thread_ts, author, reply count, status for each
- Parameters: `channel` (required), `include_resolved` (optional, default false)

**resolve_conversation**
- Posts resolution summary with checkmark emoji, marks conversation done
- Parameters: `channel` (required), `thread_ts` (required), `summary` (required)

## Message Format

### Outbound (AI sessions)

```
*[stefan-dispatcher]*: I've finished the auth module refactor.
```

Parsing regex:
```ts
const PATTERN = /^\*\[(.+?)\]\*:\s*([\s\S]*)$/
```

### Inbound (Human messages)

Messages without the `*[...]*:` prefix are from humans. Resolve the Slack user ID to a display name (cached) and identify as `human:{displayName}`.

## Configuration

### Environment Variables (from MCP config)

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (xoxb-...) |
| `SLACK_APP_TOKEN` | Yes | App-Level Token (xapp-...) with connections:write scope |
| `USERNAME` | Yes | Developer's name, used as session name prefix |
| `SESSION_ROLE` | No | Default role for announce_session |
| `REGISTRY_CHANNEL` | No | Registry channel name (default: ai-collab-registry) |

### MCP Config (.mcp.json)

```json
{
  "mcpServers": {
    "slack-collab": {
      "command": "npx",
      "args": ["tsx", "/path/to/slack-collab/src/server.ts"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_APP_TOKEN": "xapp-...",
        "USERNAME": "stefan",
        "SESSION_ROLE": "fullstack"
      }
    }
  }
}
```

### Starting Claude Code

```bash
claude --dangerously-load-development-channels server:slack-collab
```

## Slack App Setup

Create a Slack app ("Claude Bridge") with:

**Bot Token Scopes:**
- `channels:manage` - create channels
- `channels:read` - list channels
- `channels:history` - read messages
- `channels:join` - join channels
- `chat:write` - post messages
- `users:read` - resolve user display names

**Event Subscriptions (Socket Mode):**
- `message.channels` - public channel messages

**App-Level Token:**
- Scope: `connections:write`

**Channels to create:**
- `#ai-collab-registry` - global session registry
- `#team-{name}-collab` - one per team

## File Structure

```
src/
  server.ts            # Entry point, MCP server setup, tool registration
  session.ts           # SessionManager - identity, registry, fmt/parse
  subscriptions.ts     # SubscriptionManager - join/leave, local filtering
  socket-listener.ts   # Socket Mode connection, event routing
  message-bus.ts       # Event emitter, channel notification bridge
  tools/
    session.ts         # announce_session, list_sessions, set_status
    channels.ts        # subscribe_channel, unsubscribe_channel, list_subscriptions
    conversations.ts   # start/join/reply/list/resolve_conversation
  types.ts             # Shared types and interfaces
  config.ts            # Environment variable validation
```

## Testing Strategy

- **Unit tests:** Each component in isolation (MessageBus, SubscriptionManager, SessionManager)
- **Integration tests:** Mock Slack API, verify end-to-end event routing
- **Live tests:** Two sessions on same machine, verify real-time message exchange via Slack
- **Framework:** Vitest

## Security

- Sender gating: validate message sources before pushing to Claude
- Tokens never leave local machine
- No credentials in source code or git
- Bot token scopes are minimal (no admin, no DM access)

## Future Enhancements

- **SaaS Distribution (IRD-58):** OAuth install flow, server-side token management, zero token handling for end users
- **Multi-workspace support:** Connect to multiple Slack workspaces from one session
- **Permission relay:** Forward Claude Code tool approval prompts to Slack for remote approval
- **Plugin packaging:** Publish to marketplace for `/plugin install` workflow

## Jira Tickets

| Key | Summary |
|---|---|
| IRD-47 | Slack App Setup & Configuration |
| IRD-48 | Project Scaffolding & Core Types |
| IRD-49 | MessageBus Implementation |
| IRD-50 | SubscriptionManager Implementation |
| IRD-51 | Socket Mode Listener & Event Routing |
| IRD-52 | MCP Tools - Session & Channel Management |
| IRD-53 | MCP Tools - Conversation & Messaging |
| IRD-54 | MCP Tools - Real-Time Waiting (to be updated - remove wait tools, keep as Channel integration) |
| IRD-55 | Claude Code Channel Integration |
| IRD-56 | Testing & Cross-Machine Validation |
| IRD-57 | Documentation & Team Rollout |
| IRD-58 | SaaS Distribution - OAuth Install Flow & Token Management |
