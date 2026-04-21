import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `oauthRefreshTokens` table.
 *
 * Long-lived (30-day) opaque tokens issued alongside every access token.
 * Used with `grant_type=refresh_token` at `/token` to mint a new
 * access+refresh pair without re-running the authorization flow. The
 * incoming refresh token is consumed (revoked) on successful exchange — a
 * classic rotation pattern that limits replay damage to a single use.
 *
 * Binding fields match `oauthAccessTokens`; the same synthetic session is
 * reused across rotations, so the external AI's history is stable as
 * viewed through the `messages` table.
 */
export const oauthRefreshTokensTable = defineTable({
  token: v.string(),
  clientId: v.string(),
  userId: v.id('users'),
  sessionId: v.id('sessions'),
  scope: v.string(),
  expiresAt: v.number(),
  revoked: v.boolean(),
})
  .index('by_token', ['token'])
  .index('by_userId_and_clientId', ['userId', 'clientId'])
