import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `oauthAuthCodes` table.
 *
 * Short-lived (10 min) authorization codes issued by `/authorize` and
 * exchanged for access + refresh tokens at `/token`. Each code is bound to
 * the authenticated `userId` (Convex Auth, Google), the `clientId` that
 * requested it, the exact `redirectUri`, and a PKCE challenge the client
 * must prove by presenting the original `code_verifier` at exchange time.
 *
 * `used` enforces single-use: the token endpoint flips it to true atomically
 * during exchange so a leaked code can't be replayed. Expiry also bounds the
 * damage window.
 */
export const oauthAuthCodesTable = defineTable({
  code: v.string(),
  clientId: v.string(),
  userId: v.id('users'),
  redirectUri: v.string(),
  codeChallenge: v.string(),
  codeChallengeMethod: v.literal('S256'),
  scope: v.string(),
  expiresAt: v.number(),
  used: v.boolean(),
}).index('by_code', ['code'])
