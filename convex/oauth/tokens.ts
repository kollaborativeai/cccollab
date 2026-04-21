import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server.js'
import type { Doc, Id } from '../_generated/dataModel.js'
import { ACCESS_TOKEN_TTL_MS, AUTH_CODE_TTL_MS, REFRESH_TOKEN_TTL_MS, nowMs } from '../lib/time.js'

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
    if (row.revoked || row.expiresAt < nowMs()) return null
    await ctx.db.patch(row._id, { revoked: true })
    return { ...row, revoked: true }
  },
})
