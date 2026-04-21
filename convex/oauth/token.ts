import { v } from 'convex/values'
import type { GenericActionCtx } from 'convex/server'
import { action } from '../_generated/server.js'
import { internal } from '../_generated/api.js'
import { randomToken, sha256Base64Url, verifyPkceS256 } from '../lib/crypto.js'
import { ACCESS_TOKEN_TTL_MS } from '../lib/time.js'
import type { DataModel } from '../_generated/dataModel.js'

export type TokenResponse = {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
  scope: string
}

/**
 * Confidential clients (those registered with `token_endpoint_auth_method:
 * 'client_secret_post'`) must present their `client_secret` at the token
 * endpoint. Public clients (`'none'`) authenticate solely with PKCE.
 *
 * This helper looks up the client and, if confidential, verifies the presented
 * secret against the stored SHA-256 hash. Throws on failure.
 */
async function assertClientAuth(
  ctx: GenericActionCtx<DataModel>,
  clientId: string,
  clientSecret: string | null,
): Promise<void> {
  const client = await ctx.runQuery(internal.oauth.clients.getByClientId, { clientId })
  if (!client) throw new Error('unknown client')
  if (client.tokenEndpointAuthMethod === 'client_secret_post') {
    if (!clientSecret) throw new Error('client_secret required for confidential client')
    if (!client.clientSecretHash) throw new Error('client has no stored secret hash')
    const providedHash = await sha256Base64Url(clientSecret)
    if (providedHash !== client.clientSecretHash) {
      throw new Error('client_secret mismatch')
    }
  }
}

export const exchangeAuthCode = action({
  args: {
    clientId: v.string(),
    clientSecret: v.optional(v.string()),
    code: v.string(),
    codeVerifier: v.string(),
    redirectUri: v.string(),
  },
  handler: async (ctx, args): Promise<TokenResponse> => {
    await assertClientAuth(ctx, args.clientId, args.clientSecret ?? null)
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
  args: {
    clientId: v.string(),
    clientSecret: v.optional(v.string()),
    refreshToken: v.string(),
  },
  handler: async (ctx, args): Promise<TokenResponse> => {
    await assertClientAuth(ctx, args.clientId, args.clientSecret ?? null)
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
