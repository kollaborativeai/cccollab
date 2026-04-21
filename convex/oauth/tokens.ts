import { ConvexError, v } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { internalMutation, internalQuery } from '../_generated/server'
import { timingSafeEqual } from '../lib/crypto'
import { ACCESS_TOKEN_TTL_MS, AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS, nowMs } from '../lib/time'

/**
 * Internal-only CRUD for the four OAuth token tables. Public mutations /
 * actions (`register`, `authorize`, `token`) call these to keep all writes
 * into the token tables routed through a single, auditable place.
 */

export const storeAuthCode = internalMutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.literal('S256'),
    scope: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'oauthAuthCodes'>> => {
    return await ctx.db.insert('oauthAuthCodes', {
      ...args,
      expiresAt: nowMs() + AUTH_CODE_TTL_MS,
      used: false,
    })
  },
})

/**
 * Prepare the database side of a successful authorization-code exchange in
 * one atomic mutation:
 *
 *   1. validate the code (existence, not-yet-used, not-expired, clientId,
 *      redirectUri, PKCE challenge comparison)
 *   2. mark the code `used`
 *   3. revoke every non-revoked access + refresh token for (userId, clientId)
 *   4. get-or-create the synthetic session for (userId, clientId)
 *
 * Steps 2–4 happen in the same Convex transaction as step 1. That closes
 * the concurrent-double-authorize race: two parallel `/authorize` flows
 * for the same (userId, clientId) will serialise on the token-table
 * writes and the second flow's revoke + issue will observe the first
 * flow's new tokens (and revoke them correctly).
 *
 * **Why `expectedChallenge` is pre-computed by the caller**: `crypto.subtle.digest`
 * is NOT available in the Convex mutation isolate. Only the action runtime
 * exposes the full Web Crypto API. Test environments (Node / convex-test)
 * mask this because they run mutations in a normal V8 with full globals,
 * but production deployments would throw at runtime. So the action hashes
 * the verifier and hands us the result; the mutation only does a
 * constant-time string compare (no SubtleCrypto call).
 *
 * Returns the consumed auth-code row plus the synthetic sessionId so the
 * action can insert the access + refresh token rows without another round
 * trip.
 *
 * Errors propagate as ConvexError so the caller can distinguish each
 * failure mode in telemetry. The public token endpoint normalises all of
 * these to OAuth `invalid_grant` on the wire (RFC 6749 §5.2).
 */
export const consumeCodeAndPrepareSession = internalMutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    clientName: v.string(),
    redirectUri: v.string(),
    /** Caller (action) must compute `base64url(sha256(code_verifier))` and pass it here. */
    expectedChallenge: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    code: Doc<'oauthAuthCodes'>
    sessionId: Id<'sessions'>
    accessRevoked: number
    refreshRevoked: number
  }> => {
    // 1. Validate the code.
    const row = await ctx.db
      .query('oauthAuthCodes')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique()
    if (!row) {
      throw new ConvexError({ code: 'INVALID_AUTH_CODE', message: 'code not found' })
    }
    if (row.used) {
      throw new ConvexError({ code: 'INVALID_AUTH_CODE', message: 'code already consumed' })
    }
    if (row.expiresAt < nowMs()) {
      throw new ConvexError({ code: 'INVALID_AUTH_CODE', message: 'code expired' })
    }
    if (row.clientId !== args.clientId) {
      throw new ConvexError({ code: 'CLIENT_ID_MISMATCH', message: 'client_id does not match code' })
    }
    if (row.redirectUri !== args.redirectUri) {
      throw new ConvexError({ code: 'REDIRECT_URI_MISMATCH', message: 'redirect_uri does not match code' })
    }
    // Constant-time compare of caller-supplied expectedChallenge against
    // the stored challenge. No SubtleCrypto call here on purpose.
    if (!timingSafeEqual(args.expectedChallenge, row.codeChallenge)) {
      throw new ConvexError({ code: 'PKCE_MISMATCH', message: 'code_verifier does not match stored challenge' })
    }

    // 2. Consume the code.
    await ctx.db.patch(row._id, { used: true })

    // 3. Revoke existing tokens for (userId, clientId) atomically.
    let accessRevoked = 0
    const accessRows = await ctx.db
      .query('oauthAccessTokens')
      .withIndex('by_userId_and_clientId', (q) => q.eq('userId', row.userId).eq('clientId', args.clientId))
      .collect()
    for (const t of accessRows) {
      if (t.revoked) continue
      await ctx.db.patch(t._id, { revoked: true })
      accessRevoked++
    }
    let refreshRevoked = 0
    const refreshRows = await ctx.db
      .query('oauthRefreshTokens')
      .withIndex('by_userId_and_clientId', (q) => q.eq('userId', row.userId).eq('clientId', args.clientId))
      .collect()
    for (const t of refreshRows) {
      if (t.revoked) continue
      await ctx.db.patch(t._id, { revoked: true })
      refreshRevoked++
    }

    // 4. Get-or-create the synthetic external session for (userId, clientId).
    const sessionName = sessionNameFor(args.clientId, args.clientName)
    const existingSession = await ctx.db
      .query('sessions')
      .withIndex('by_user_and_sessionName', (q) => q.eq('userId', row.userId).eq('sessionName', sessionName))
      .unique()
    let sessionId: Id<'sessions'>
    const now = nowMs()
    if (existingSession) {
      await ctx.db.patch(existingSession._id, { lastSeenAt: now })
      sessionId = existingSession._id
    } else {
      sessionId = await ctx.db.insert('sessions', {
        userId: row.userId,
        sessionName,
        objective: `External MCP client: ${args.clientName}`,
        machine: 'external-mcp',
        createdAt: now,
        lastSeenAt: now,
      })
    }

    return { code: { ...row, used: true }, sessionId, accessRevoked, refreshRevoked }
  },
})

export const issueAccessToken = internalMutation({
  args: {
    token: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    sessionId: v.id('sessions'),
    scope: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'oauthAccessTokens'>> => {
    return await ctx.db.insert('oauthAccessTokens', {
      ...args,
      expiresAt: nowMs() + ACCESS_TOKEN_TTL_MS,
      revoked: false,
    })
  },
})

export const issueRefreshToken = internalMutation({
  args: {
    token: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    sessionId: v.id('sessions'),
    scope: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'oauthRefreshTokens'>> => {
    return await ctx.db.insert('oauthRefreshTokens', {
      ...args,
      expiresAt: nowMs() + REFRESH_TOKEN_TTL_MS,
      revoked: false,
    })
  },
})

export const resolveAccessToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<Doc<'oauthAccessTokens'> | null> => {
    const row = await ctx.db
      .query('oauthAccessTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique()
    if (!row) return null
    if (row.revoked || row.expiresAt < nowMs()) return null
    return row
  },
})

export const consumeRefreshToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<Doc<'oauthRefreshTokens'> | null> => {
    const row = await ctx.db
      .query('oauthRefreshTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique()
    if (!row) return null
    if (row.revoked || row.expiresAt < nowMs()) {
      throw new ConvexError({ code: 'INVALID_REFRESH_TOKEN', message: 'refresh_token revoked or expired' })
    }
    await ctx.db.patch(row._id, { revoked: true })
    return { ...row, revoked: true }
  },
})

/** The sessionName we use for external AI clients. Stable, so a Claude.ai
 *  re-authorize reuses the same synthetic session. `clientId` is included
 *  so two different AI apps authorized by the same user are distinct. */
function sessionNameFor(clientId: string, clientName: string): string {
  const safeName = clientName.replace(/[^\w .-]/g, '').slice(0, 40)
  const idSuffix = clientId.slice(0, 8)
  return `${safeName} (external/${idSuffix})`
}
