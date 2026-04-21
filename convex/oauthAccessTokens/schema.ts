import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `oauthAccessTokens` table.
 *
 * Opaque 256-bit bearer tokens issued at `/token` after successful code
 * exchange (or refresh). A valid (non-revoked, non-expired) row authorises
 * the bearer to act as `userId` via a synthetic `sessions` row.
 *
 * Fields:
 * - `sessionId`: the synthetic `sessions` row we created for this (userId,
 *   clientId) pair. External-AI messages are inserted with this `sessionId`
 *   as their `fromSessionId`, which keeps the `messages` table's existing
 *   invariants (every message has a real session + user) intact. The
 *   session is shared across token rotations for the same client.
 * - `scope`: space-separated scopes granted at issue time. Enforced at the
 *   MCP gateway; unknown scopes are rejected at `/authorize`.
 * - `expiresAt`: 1-hour TTL; rotation happens via `/token` with
 *   `grant_type=refresh_token`.
 */
export const oauthAccessTokensTable = defineTable({
  token: v.string(),
  clientId: v.string(),
  userId: v.id('users'),
  sessionId: v.id('sessions'),
  scope: v.string(),
  expiresAt: v.number(),
  revoked: v.boolean(),
}).index('by_token', ['token'])
