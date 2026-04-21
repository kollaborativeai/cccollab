import { ConvexError, v } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { internalMutation, internalQuery } from '../_generated/server'
import { sha256Base64Url, timingSafeEqual } from '../lib/crypto'
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
 * Validate a presented auth code against its bindings AND consume it in a
 * single atomic mutation. Order matters: all checks run before the `used`
 * flag is flipped, so a legitimate client that sends the right code with a
 * wrong `redirect_uri` or wrong `code_verifier` can retry — the code is not
 * burned on a mismatch.
 *
 * Errors propagate as ConvexError so the caller can distinguish "expired"
 * from "wrong verifier" from "wrong redirect_uri" in telemetry. The public
 * token endpoint normalises all of these to OAuth `invalid_grant` on the
 * wire (RFC 6749 §5.2).
 */
export const validateAndConsumeAuthCode = internalMutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeVerifier: v.string(),
  },
  handler: async (ctx, args): Promise<Doc<'oauthAuthCodes'>> => {
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
    // PKCE S256 verify — happens in the mutation so the consume is
    // guarded by the verifier check (no burning a code on a typo).
    const expectedChallenge = await sha256Base64Url(args.codeVerifier)
    if (!timingSafeEqual(expectedChallenge, row.codeChallenge)) {
      throw new ConvexError({ code: 'PKCE_MISMATCH', message: 'code_verifier does not match stored challenge' })
    }
    await ctx.db.patch(row._id, { used: true })
    return { ...row, used: true }
  },
})

/**
 * Revoke every non-revoked access + refresh token for (userId, clientId).
 * Called from exchangeAuthCode before issuing a new pair on re-authorize,
 * so a leaked previous-session token doesn't stay valid alongside the
 * new one for up to the access-token TTL.
 */
export const revokeExistingTokens = internalMutation({
  args: { userId: v.id('users'), clientId: v.string() },
  handler: async (ctx, { userId, clientId }): Promise<{ accessRevoked: number; refreshRevoked: number }> => {
    let accessRevoked = 0
    const access = await ctx.db
      .query('oauthAccessTokens')
      .withIndex('by_userId_and_clientId', (q) => q.eq('userId', userId).eq('clientId', clientId))
      .collect()
    for (const row of access) {
      if (row.revoked) continue
      await ctx.db.patch(row._id, { revoked: true })
      accessRevoked++
    }
    let refreshRevoked = 0
    const refresh = await ctx.db
      .query('oauthRefreshTokens')
      .withIndex('by_userId_and_clientId', (q) => q.eq('userId', userId).eq('clientId', clientId))
      .collect()
    for (const row of refresh) {
      if (row.revoked) continue
      await ctx.db.patch(row._id, { revoked: true })
      refreshRevoked++
    }
    return { accessRevoked, refreshRevoked }
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

export const getOrCreateExternalSession = internalMutation({
  args: { userId: v.id('users'), clientId: v.string(), clientName: v.string() },
  handler: async (ctx, { userId, clientId, clientName }): Promise<Id<'sessions'>> => {
    // One synthetic session per (userId, clientId) — reused across token
    // rotations so the external AI's history in `messages` is stable.
    const sessionName = sessionNameFor(clientId, clientName)
    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_user_and_sessionName', (q) => q.eq('userId', userId).eq('sessionName', sessionName))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeenAt: nowMs() })
      return existing._id
    }
    const now = nowMs()
    return await ctx.db.insert('sessions', {
      userId,
      sessionName,
      objective: `External MCP client: ${clientName}`,
      machine: 'external-mcp',
      createdAt: now,
      lastSeenAt: now,
    })
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
