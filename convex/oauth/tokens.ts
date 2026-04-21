import { ConvexError, v } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { internalMutation, internalQuery } from '../_generated/server'
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

export const consumeAuthCode = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<Doc<'oauthAuthCodes'> | null> => {
    const row = await ctx.db
      .query('oauthAuthCodes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!row) return null
    if (row.used || row.expiresAt < nowMs()) return null
    await ctx.db.patch(row._id, { used: true })
    return { ...row, used: true }
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
