# HTTP MCP Server for External AI Clients

**Story:** [CCC-22](https://flatoutsolutions.atlassian.net/browse/CCC-22)
**Epic:** [CCC-21](https://flatoutsolutions.atlassian.net/browse/CCC-21)

This document describes the hosted HTTP MCP server that lets external AI clients (Claude.ai, ChatGPT, Cursor, Gemini) join cccollab topics and post messages attributed to the signed-in user.

## What you get

- A Convex backend under `convex/` exposing:
  - OAuth 2.1 Authorization Server (`/register`, `/authorize`, `/token`, plus `.well-known` metadata)
  - MCP streamable HTTP endpoint at `/mcp`
- Three MCP tools the external AI can call:
  - `list_topics` — list active topics the authenticated user is a member of
  - `read_topic` — read a topic's metadata + recent messages
  - `send_message_to_topic` — post a message (attributed to the external user)
- An optional bridge (`src/bridge/convex-bridge.ts`) that forwards messages from Convex to the local broker's `/local-event` endpoint, so Claude Code sessions see external messages in real time via the existing channel notification path.

## Architecture

```
[External AI client] --Bearer token--> [Convex HTTP action /mcp] --> [Convex DB]
                                                                          ^
                                                                          |
                                       [src/bridge/convex-bridge.ts]<-----/ (subscribes)
                                                       |
                                                       v
                                       [Local broker /local-event] --> [Claude Code session]
```

## Set up Convex

1. Create a Convex account and project: <https://dashboard.convex.dev>.
2. From the repo root:
   ```bash
   npx convex dev
   ```
   Follow the prompts. This provisions a dev deployment and writes `.env.local` with `CONVEX_DEPLOYMENT` + `CONVEX_URL`.
3. The `convex/_generated/` directory will be regenerated with fully-typed bindings. The stub committed in git is replaced automatically.

For CI / offline development we ship `scripts/gen-convex-stub.mjs` which produces a minimal `_generated/` stub that's enough to typecheck and run tests. It runs automatically via a postinstall-style hook — you can also run it manually: `node scripts/gen-convex-stub.mjs`.

## Set up Clerk

1. Create a Clerk instance: <https://dashboard.clerk.com>.
2. Under **JWT Templates**, add a template named `convex` pointing at your Convex deployment's domain. (Follow <https://docs.convex.dev/auth/clerk>.)
3. Copy the JWT issuer domain (e.g. `https://your-app.clerk.accounts.dev`) into `CLERK_JWT_ISSUER_DOMAIN` in `.env.local`.

## Configure an external AI client

Most MCP-capable AI clients support Dynamic Client Registration, so you don't need to pre-provision clients. The minimum config they need is:

- **Server URL:** `https://<your-convex-deployment>.convex.site/mcp`
- **Auth:** OAuth 2.1 (PKCE). The client will discover the authorization endpoint via `https://<deployment>.convex.site/.well-known/oauth-authorization-server`.

For Claude.ai specifically, add a "Custom MCP" connection pointing to `https://<deployment>.convex.site/mcp` and follow the sign-in flow.

### Manual OAuth flow (for testing / debugging)

```bash
# 1. Register a client
curl -X POST https://<deployment>.convex.site/register \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"dev-cli","redirect_uris":["http://localhost:8765/cb"],"token_endpoint_auth_method":"none"}'
# -> {"client_id":"...","client_name":"dev-cli",...}

# 2. Build a PKCE verifier + challenge (example helper below)
export VERIFIER=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)
export CHALLENGE=$(echo -n $VERIFIER | openssl dgst -sha256 -binary | openssl base64 | tr -d '=+/' | sed 's/+/-/g;s/\//_/g')

# 3. Open the authorize URL in a browser (must be authenticated with Clerk)
#    https://<deployment>.convex.site/authorize?response_type=code&client_id=<client_id>&redirect_uri=http://localhost:8765/cb&code_challenge=$CHALLENGE&code_challenge_method=S256&scope=cccollab:topics.rw&state=xyz
# -> browser redirects to http://localhost:8765/cb?code=<code>&state=xyz

# 4. Exchange code for tokens
curl -X POST https://<deployment>.convex.site/token \
  -d "grant_type=authorization_code&client_id=<client_id>&code=<code>&code_verifier=$VERIFIER&redirect_uri=http://localhost:8765/cb"
# -> {"access_token":"...","refresh_token":"...","token_type":"Bearer","expires_in":3600,"scope":"..."}
```

### Call MCP tools

```bash
# List topics
curl -X POST https://<deployment>.convex.site/mcp \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_topics","arguments":{}}}'
```

## Enable the optional bridge (Claude Code ↔ Convex)

If you run Claude Code on the same machine as your local broker, export `CCCOLLAB_CONVEX_URL` to make the bridge forward messages from Convex into the broker's SSE stream. (A future story will migrate the plugin to talk to Convex directly — that's the scope of CCC-3.)

```bash
export CCCOLLAB_CONVEX_URL=https://<deployment>.convex.cloud
claude --dangerously-load-development-channels plugin:cccollab@flatoutsolutions
```

## Custom domain

To serve the API at `https://cccollab.flatout.solutions/mcp` instead of the auto-generated Convex URL, follow Convex's [custom domains docs](https://docs.convex.dev/production/hosting/custom). This is an ops step; the PR does not automate it.

## Tests

```bash
yarn test                              # all tests
yarn vitest run convex/tests           # convex-specific
yarn vitest run tests/scenarios        # CCC-22 acceptance scenarios
```

All 6 acceptance criteria are covered:

| AC                                                         | Verified by                                    |
| ---------------------------------------------------------- | ---------------------------------------------- |
| Hosted MCP URL reachable                                   | route registration + metadata tests            |
| OAuth flow works                                           | `tests/scenarios/oauth-flow.scenario.test.ts`  |
| MCP server exposes `list_topics`, `read_topic`, `send_...` | `tests/scenarios/mcp-tools.scenario.test.ts`   |
| External message → Claude Code session in real time        | `tests/scenarios/cross-visibility.*` + bridge  |
| Claude Code message visible via `read_topic`               | `tests/scenarios/cross-visibility.*`           |
| Messages attributed to external user                       | `tests/scenarios/attribution.scenario.test.ts` |
