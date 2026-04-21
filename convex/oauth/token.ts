import { ConvexError, v } from 'convex/values'
import type { GenericActionCtx } from 'convex/server'

import { internal } from '../_generated/api'
import type { DataModel } from '../_generated/dataModel'
import { action } from '../_generated/server'
import { randomToken, sha256Base64Url, timingSafeEqual } from '../lib/crypto'
import { ACCESS_TOKEN_TTL_MS } from '../lib/time'

/**
 * Token endpoint (RFC 6749 §3.2): exchange an auth code for access +
 * refresh tokens, or rotate a refresh token. Both grant types run as
 * actions because they call other mutations sequentially.
 */

export type TokenResponse = {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
  scope: string
}

/** Confidential-client authentication. Public clients (`none`) skip
 *  client_secret entirely; confidential clients (`client_secret_post`)
 *  must present their secret and we verify it against the stored hash
 *  via a constant-time comparison. */
async function assertClientAuth(
  ctx: GenericActionCtx<DataModel>,
  clientId: string,
  clientSecret: string | null,
): Promise<void> {
  const client = await ctx.runQuery(internal.oauth.clients.getByClientId, { clientId })
  if (!client) {
    throw new ConvexError({ code: 'UNKNOWN_CLIENT', message: 'client_id is not registered' })
  }
  if (client.tokenEndpointAuthMethod === 'client_secret_post') {
    if (!clientSecret) {
      throw new ConvexError({
        code: 'INVALID_CLIENT',
        message: 'client_secret required for this client',
      })
    }
    if (!client.clientSecretHash) {
      throw new ConvexError({
        code: 'INVALID_CLIENT',
        message: 'client has no stored secret hash',
      })
    }
    const provided = await sha256Base64Url(clientSecret)
    if (!timingSafeEqual(provided, client.clientSecretHash)) {
      throw new ConvexError({ code: 'INVALID_CLIENT', message: 'client_secret mismatch' })
    }
  }
}

export const exchangeAuthCode = action({
  args: {
    clientId: v.string(),
    clientSecret: v.optional(v.string()),
    clientName: v.optional(v.string()),
    code: v.string(),
    codeVerifier: v.string(),
    redirectUri: v.string(),
  },
  handler: async (ctx, args): Promise<TokenResponse> => {
    await assertClientAuth(ctx, args.clientId, args.clientSecret ?? null)

    // All validation + consume happens atomically in one mutation. A
    // typo in redirect_uri or code_verifier does NOT burn the code —
    // the client can retry. Only successful validation marks it used.
    const codeRow = await ctx.runMutation(internal.oauth.tokens.validateAndConsumeAuthCode, {
      code: args.code,
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      codeVerifier: args.codeVerifier,
    })

    // Re-authorize semantics: if this same user has previously issued
    // tokens to this same client, revoke the old ones before minting new
    // ones. A successful full-flow authorize is the moment of highest
    // certainty that the user wants to start fresh; letting old tokens
    // stay valid alongside would leave a leaked-but-forgotten previous
    // token usable for up to the 1h access-token TTL.
    await ctx.runMutation(internal.oauth.tokens.revokeExistingTokens, {
      userId: codeRow.userId,
      clientId: codeRow.clientId,
    })

    const sessionId = await ctx.runMutation(internal.oauth.tokens.getOrCreateExternalSession, {
      userId: codeRow.userId,
      clientId: codeRow.clientId,
      clientName: args.clientName ?? 'External MCP client',
    })

    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.issueAccessToken, {
      token: accessToken,
      clientId: codeRow.clientId,
      userId: codeRow.userId,
      sessionId,
      scope: codeRow.scope,
    })
    await ctx.runMutation(internal.oauth.tokens.issueRefreshToken, {
      token: refreshToken,
      clientId: codeRow.clientId,
      userId: codeRow.userId,
      sessionId,
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
    if (!row) {
      throw new ConvexError({ code: 'INVALID_GRANT', message: 'invalid or expired refresh_token' })
    }
    if (row.clientId !== args.clientId) {
      throw new ConvexError({ code: 'INVALID_GRANT', message: 'client_id mismatch' })
    }

    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.issueAccessToken, {
      token: accessToken,
      clientId: row.clientId,
      userId: row.userId,
      sessionId: row.sessionId,
      scope: row.scope,
    })
    await ctx.runMutation(internal.oauth.tokens.issueRefreshToken, {
      token: refreshToken,
      clientId: row.clientId,
      userId: row.userId,
      sessionId: row.sessionId,
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
