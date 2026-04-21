# HTTP MCP server for external AI clients

**Story:** [CCC-22](https://flatoutsolutions.atlassian.net/browse/CCC-22)
**Epic:** [CCC-21](https://flatoutsolutions.atlassian.net/browse/CCC-21)
**Depends on:** [CCC-3](https://flatoutsolutions.atlassian.net/browse/CCC-3)

Hosts an MCP-streamable HTTP endpoint at `/mcp` on the same Convex deployment
used by the first-party cccollab MCP server. External AI clients (Claude.ai,
ChatGPT, Cursor, Gemini — anything with MCP support) can authorize via OAuth
2.1, then list topics, read transcripts, and post messages on behalf of a
cccollab user.

## What you get

Three MCP tools, all scoped to what the underlying human user can see:

- `list_topics` — active topics in channels the user has joined
- `read_topic` — topic metadata + the last 200 messages (oldest first)
- `send_message_to_topic` — post to a topic, attributed to a per-client synthetic session

Plus the OAuth 2.1 authorization-server surface that the MCP clients discover
via `.well-known`:

- `GET  /.well-known/oauth-authorization-server`
- `GET  /.well-known/oauth-protected-resource`
- `POST /register` — RFC 7591 Dynamic Client Registration
- `GET  /authorize` — RFC 6749 §4.1 + PKCE S256 (Convex Auth signs the user in)
- `POST /token` — RFC 6749 §3.2 (authorization_code + refresh_token grants)

## Security model in one paragraph

The external AI cannot exceed what the human user can do. At authorize time
the user must be signed in via Convex Auth (Google, with the `@flatout.solutions`
allow-list). At read / write time, every tool call goes through an internal
mutation that checks the user's `channelMembers` row for the topic's parent
channel. No channel membership → the AI can't see or post in that topic.
Messages are attributed to a synthetic `sessions` row (one per OAuth client
per user, reused across token rotations), so the existing `messages` schema
is honored without needing to extend `kind`.

## How the data fits

| Layer       | File                                         | Role                                                                                                      |
| ----------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Schema      | `convex/oauthClients/schema.ts` + 3 siblings | OAuth state tables                                                                                        |
| Schema      | `convex/schema.ts`                           | Compose new tables with Stefan's domain schema                                                            |
| Auth server | `convex/oauth/`                              | register, authorize, token (exchange + refresh), metadata                                                 |
| Transport   | `convex/mcp/server.ts`                       | JSON-RPC dispatcher with tool/notification routing                                                        |
| Ops         | `convex/mcp/ops.ts`                          | Internal mutations called by tool handlers (membership-aware)                                             |
| HTTP wiring | `convex/http.ts`                             | Routes all of the above at the Convex HTTP action layer                                                   |
| Bridge      | (dropped)                                    | CCC-3's remote transport delivers messages to Claude Code sessions directly; no per-machine bridge needed |

## Setup

### 1. Convex

The Convex deployment is the same one CCC-3 uses. No separate backend.
The new OAuth tables compose with Stefan's schema via `defineSchema`.

```bash
npx convex dev    # first time; provisions the dev deployment + pushes schema
```

### 2. Clerk — not required

Unlike the v1 design, we dropped Clerk and reuse Stefan's Convex Auth + Google
OAuth setup. External AI clients sign their users in through that flow.

### 3. Environment

See `.env.example`. Nothing new beyond what CCC-3 already needs.

## Using it from an MCP client

Most MCP-capable clients support RFC 7591 Dynamic Client Registration — you
paste the server URL (`https://<deployment>.convex.site/mcp`), the client
discovers `/authorize` + `/token` via `.well-known`, registers itself, and
the user does the Google sign-in once. Claude.ai, Cursor, ChatGPT with MCP,
and Gemini MCP all work this way.

### Manual curl walkthrough

```bash
# 0. Generate PKCE verifier / challenge
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/' | cut -c1-43)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr -d '=' | tr '+/' '-_')

# 1. Register the client
curl -sX POST https://<deployment>.convex.site/register \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"test","redirect_uris":["http://127.0.0.1:8765/cb"],"token_endpoint_auth_method":"none"}'
# -> { "client_id": "...", "client_name": "test", ... }

# 2. Send the user to /authorize in their browser (they must be signed in
#    to cccollab via Google). Convex redirects back to redirect_uri with ?code=...
open "https://<deployment>.convex.site/authorize?response_type=code&client_id=<client_id>&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcb&code_challenge=$CHALLENGE&code_challenge_method=S256&scope=cccollab%3Atopics.rw&state=xyz"

# 3. Exchange the code for tokens
curl -sX POST https://<deployment>.convex.site/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=<client_id>" \
  --data-urlencode "code=<code>" \
  --data-urlencode "code_verifier=$VERIFIER" \
  --data-urlencode "redirect_uri=http://127.0.0.1:8765/cb"
# -> { "access_token": "...", "refresh_token": "...", "token_type": "Bearer", ... }

# 4. Call MCP tools with the bearer
curl -sX POST https://<deployment>.convex.site/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <access_token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_topics","arguments":{}}}'
```

## Scenario tests

End-to-end scenarios live in `convex/tests/` alongside the Convex function
tests. They drive the real HTTP router via `t.fetch('/mcp')` with bearer
tokens obtained through the full OAuth flow — no mocks at the protocol
boundary.

| Scenario          | File                         | What it covers                                                                                               |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| OAuth flow        | `convex/tests/oauth.test.ts` | register → authorize (PKCE) → token → refresh; confidential / public; same-code reuse blocked; PKCE mismatch |
| MCP protocol      | `convex/tests/mcp.test.ts`   | initialize, tools/list, notifications/\*, -32601/-32602 error shapes                                         |
| End-to-end tools  | `convex/tests/mcp.test.ts`   | `list_topics` + `read_topic` + `send_message_to_topic` through `/mcp` with real tokens                       |
| Scoping           | `convex/tests/mcp.test.ts`   | non-channel-members blocked from read + write; archived topics hidden                                        |
| Synthetic session | `convex/tests/oauth.test.ts` | one session per (userId, clientId), reused across refreshes                                                  |

Run: `yarn test:convex`.

## What's deferred

- Real-time push into the external AI client's chat (out of scope per the
  ticket — MCP clients don't all support server-initiated messages).
- Per-client rate limiting (out of scope per the ticket).
- Production deployment to `cccollab.flatout.solutions/mcp` is an ops step
  — custom-domain config on the Convex dashboard.
