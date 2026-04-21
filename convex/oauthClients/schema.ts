import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `oauthClients` table.
 *
 * Stores dynamic-client-registration records (RFC 7591) for external AI
 * clients (Claude.ai, ChatGPT, Cursor, Gemini, ...). A client is created
 * via the public `POST /register` HTTP endpoint — no authentication
 * required — and receives a `client_id` plus, for confidential clients,
 * a `client_secret` that is stored only as a SHA-256 hash.
 *
 * Distinct from Convex Auth's own `authAccounts` / `authSessions` tables,
 * which track *human* sign-ins. OAuth clients here are the third-party
 * applications that act on behalf of humans; the access tokens that they
 * exchange for (see `oauthAccessTokens`) are bound to a specific `userId`
 * (Convex Auth user) via the OAuth authorization flow.
 *
 * Invariant: at most one row per `clientId`. Enforced at the mutation layer
 * (`by_clientId` lookup-then-insert); IDs are 256-bit random tokens so
 * collisions are astronomically unlikely, but the uniqueness is structural.
 */
export const oauthClientsTable = defineTable({
  clientId: v.string(),
  clientName: v.string(),
  redirectUris: v.array(v.string()),
  tokenEndpointAuthMethod: v.union(v.literal('none'), v.literal('client_secret_post')),
  clientSecretHash: v.optional(v.string()),
  createdAt: v.number(),
}).index('by_clientId', ['clientId'])
