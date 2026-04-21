import { v } from 'convex/values'
import { action } from '../_generated/server.js'
import { internal } from '../_generated/api.js'
import { randomToken, verifyPkceS256 } from '../lib/crypto.js'
import { ACCESS_TOKEN_TTL_MS } from '../lib/time.js'

export type TokenResponse = {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
  scope: string
}

export const exchangeAuthCode = action({
  args: {
    clientId: v.string(),
    code: v.string(),
    codeVerifier: v.string(),
    redirectUri: v.string(),
  },
  handler: async (ctx, args): Promise<TokenResponse> => {
    const codeRow = await ctx.runMutation(internal.oauth.tokens.consumeAuthCode, { code: args.code })
    if (!codeRow) throw new Error('invalid or expired code')
    if (codeRow.clientId !== args.clientId) throw new Error('client_id mismatch')
    if (codeRow.redirectUri !== args.redirectUri) throw new Error('redirect_uri mismatch')
    const ok = await verifyPkceS256({
      verifier: args.codeVerifier,
      challenge: codeRow.codeChallenge,
    })
    if (!ok) throw new Error('pkce verifier mismatch')

    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.issueAccessToken, {
      token: accessToken,
      clientId: codeRow.clientId,
      userId: codeRow.userId,
      scope: codeRow.scope,
    })
    await ctx.runMutation(internal.oauth.tokens.issueRefreshToken, {
      token: refreshToken,
      clientId: codeRow.clientId,
      userId: codeRow.userId,
      scope: codeRow.scope,
    })
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: codeRow.scope,
    }
  },
})

export const refreshAccessToken = action({
  args: { clientId: v.string(), refreshToken: v.string() },
  handler: async (ctx, args): Promise<TokenResponse> => {
    const row = await ctx.runMutation(internal.oauth.tokens.consumeRefreshToken, {
      token: args.refreshToken,
    })
    if (!row) throw new Error('invalid or expired refresh_token')
    if (row.clientId !== args.clientId) throw new Error('client_id mismatch')

    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.issueAccessToken, {
      token: accessToken,
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
    })
    await ctx.runMutation(internal.oauth.tokens.issueRefreshToken, {
      token: refreshToken,
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
    })
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: row.scope,
    }
  },
})
