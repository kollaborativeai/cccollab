# CCC-22: External LLMs Participate in Topics via Hosted HTTP MCP Server - Design

**Epic:** [CCC-21](https://flatoutsolutions.atlassian.net/browse/CCC-21) — Non-technical participants collaborate in topics via portal or external LLM
**Story:** [CCC-22](https://flatoutsolutions.atlassian.net/browse/CCC-22)
**Depends on:** [CCC-3](https://flatoutsolutions.atlassian.net/browse/CCC-3) — Hosted Convex backend (In Progress)

## Goal

Allow external users on Claude.ai / ChatGPT / Gemini / Cursor to connect to cccollab topics via a hosted HTTP MCP server. They get OAuth-based access, can list their topics, read transcripts, and post messages attributed to themselves.

## Architecture Overview

```
  [External AI client (Claude.ai/ChatGPT/Cursor)]
                    |
             MCP Streamable HTTP (JSON-RPC + bearer token)
                    |
                    v
   +--------------------------------------------+
   | Convex HTTP Actions (https://<dep>.convex.site) |
   | - /.well-known/oauth-authorization-server      |
   | - /.well-known/oauth-protected-resource        |
   | - /register  (RFC 7591)                        |
   | - /authorize (PKCE + Clerk consent)            |
   | - /token     (code exchange, refresh)          |
   | - /mcp       (JSON-RPC tool dispatch)          |
   +--------------------------------------------+
                    |
                    v
   +--------------------------------------------+
   | Convex Backend (queries, mutations, db)        |
   | Tables: users, channels, topics, messages,     |
   |         topicMemberships, channelMemberships,  |
   |         oauthClients, oauthAuthCodes,          |
   |         oauthAccessTokens, oauthRefreshTokens  |
   +--------------------------------------------+
                    ^
                    | (Convex bridge - optional, env-flagged)
                    |
   +--------------------------------------------+
   | Local broker (existing)                        |
   | Forwards Convex messages to broker SSE         |
   | so the plugin's existing channel path delivers |
   | them into the Claude Code session.             |
   +--------------------------------------------+
```

## Scope

### In scope (this story)

1. Convex backend scaffolded in `convex/` directory with schema for users, channels, topics, messages, memberships, OAuth state.
2. Convex HTTP actions implementing OAuth 2.1 Authorization Server (RFC 8414/9728/7591/7636):
   - Authorization Server Metadata endpoint
   - Protected Resource Metadata endpoint
   - Dynamic Client Registration endpoint
   - Authorization endpoint with PKCE S256
   - Token endpoint (code exchange + refresh)
3. Convex HTTP action implementing MCP streamable HTTP transport at `/mcp`.
4. Three MCP tools: `list_topics`, `read_topic`, `send_message_to_topic`, scoped by authenticated user's memberships.
5. Attribution: messages from external users stored with `authorType: 'external'`, `authorName: <user's Clerk displayName>`.
6. Convex-to-broker bridge: `src/bridge/convex-bridge.ts` that subscribes to Convex `messages` table (reactive query) and forwards new messages to the local broker's `/local-event` SSE endpoint. Opt-in via `CCCOLLAB_CONVEX_URL` env var.
7. Scenario tests (Vitest integration level):
   - OAuth flow: dynamic client registration → authorize (PKCE) → token exchange
   - Tool access: each tool callable with valid bearer token
   - Attribution: message posted via MCP is attributed to external user
   - Cross-visibility: external AI sends → Claude Code session receives via broker bridge
   - Scoping: user only sees their own topics/memberships

### Out of scope (deferred)

- Real-time push into external AI client's chat (out of scope per ticket).
- Write operations on topics/channels (MVP is read + message-in-topic only).
- Full Clerk consent UI for OAuth authorize (we render a minimal HTML consent page; portal story CCC-TBD will provide the rich UI).
- Rate limiting (per ticket out of scope).
- Production deployment (we provide deploy instructions + CI; actual deployment to `cccollab.flatout.solutions/mcp` is an ops step).
- Full replacement of local broker with Convex — that is CCC-3's scope.

## Key Design Decisions

### Convex project layout

All Convex code lives under `convex/`. This is the standard Convex convention. The main deliverables:
- `convex/schema.ts` — DB schema
- `convex/auth.config.ts` — Clerk JWT issuer
- `convex/{users,topics,messages,channels}.ts` — CRUD functions
- `convex/oauth/` — OAuth authorization-server logic
- `convex/mcp/` — MCP protocol handler
- `convex/http.ts` — HTTP router mounting all endpoints
- `convex/lib/` — utilities

Convex functions are either `query` (read), `mutation` (write), `action` (external side effects), or `httpAction` (HTTP endpoints).

### Auth model

- **Human users** authenticate via Clerk on a web page. This is used for the OAuth consent step.
- **External AI clients** authenticate to MCP using an OAuth 2.1 access token (bearer). The token is bound to a Clerk user.
- When an MCP tool is called, we look up the access token → Clerk user ID → Convex `users` record.
- Clerk webhook syncs user creation into the `users` table; if the user does not exist when hitting authorize, we create them just-in-time from the Clerk token.

### OAuth 2.1 specifics

- **Authorization code flow with PKCE (S256)** — required by MCP spec.
- **Dynamic Client Registration** — AI clients register themselves at `/register`.
- **Access tokens**: opaque random tokens (256-bit), 1-hour TTL, stored in Convex.
- **Refresh tokens**: opaque random tokens (256-bit), 30-day TTL, rotatable.
- **Scope**: single scope `cccollab:topics.rw` for MVP.

### MCP streamable HTTP

- Single endpoint: `POST /mcp` with JSON-RPC 2.0 body.
- Response: `application/json` (single response). No SSE stream for MVP (we don't push server-initiated messages).
- Bearer token auth required via `Authorization: Bearer <token>` header.
- Implements `initialize`, `tools/list`, `tools/call`, `ping`.

### Message attribution

`messages` table has:
- `authorType`: `'session'` (Claude Code via CCC-3 eventually) or `'external'` (HTTP MCP)
- `authorKey`: unique key for the author (Clerk userId for external, session name for sessions)
- `authorName`: display name

When rendering in Claude Code's channel tag, messages from external authors look like:
```xml
<channel source="cccollab" topic="X" sender="alice@example.com" authorType="external">...
```

### Convex bridge (optional real-time path)

`src/bridge/convex-bridge.ts` is a standalone Node process launched when `CCCOLLAB_CONVEX_URL` is set. It:
1. Opens Convex reactive subscription on `messages.listRecent`.
2. When new messages arrive, POSTs them to the local broker's `/local-event` endpoint with a channel envelope.
3. The broker broadcasts to all connected SSE clients (i.e. Claude Code sessions).

This satisfies AC#4 (external message → Claude Code in real time) without requiring full CCC-3 migration.

## Testing Strategy

Three layers:

1. **Unit tests** for pure functions (PKCE, token generation, schema validators) — Vitest.
2. **Convex function tests** using `convex-test` — run queries/mutations against in-memory Convex. Tests under `convex/tests/`.
3. **Scenario tests** at `tests/scenarios/` — drive the HTTP endpoints end-to-end using `fetch` against a local Convex dev server (or a test harness that mounts the HTTP actions). These verify the full ACs.

Scenario test fixtures create fake Clerk identities using a mocked Clerk issuer; no real Clerk credentials required.

## Deployment

- Convex deployment created via `npx convex dev` (development) and `npx convex deploy` (production).
- Clerk instance configured with JWT template named `convex` pointing at the Convex deployment domain.
- Custom domain `cccollab.flatout.solutions/mcp` mapped to `<deployment>.convex.site/mcp` — DNS + Convex custom domain config (documented in README; actual ops step is owner's responsibility and out of scope of this PR).

## Risks

1. **CCC-3 merge conflict** — Stefan is implementing CCC-3 in parallel. Mitigation: our Convex schema follows the Epic's data model, so merge is a superset union. We avoid modifying existing plugin files except to add the opt-in bridge (new file).
2. **MCP OAuth complexity** — MCP OAuth 2.1 is a nontrivial spec. Mitigation: implement incrementally with tests at each step; keep auth-server surface small.
3. **Clerk external config** — Requires a real Clerk project. Mitigation: ship a `.env.example`, document setup; scenario tests use a mock issuer.

## Non-Goals

- Browser-based UI for consent (minimal HTML stub sufficient).
- Admin / management UI for OAuth clients.
- Per-client rate limiting (YAGNI per ticket).
