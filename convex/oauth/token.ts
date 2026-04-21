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

    // PKCE hash is computed in the action: `crypto.subtle.digest` is not
    // available in the Convex mutation isolate, only in the action
    // runtime. We pre-hash the verifier here and hand the mutation a
    // string to constant-time compare against the stored challenge.
    const expectedChallenge = await sha256Base64Url(args.codeVerifier)

    // ONE atomic mutation does: validate + consume + revoke prior tokens
    // for (userId, clientId) + get-or-create synthetic session. Running
    // all four in a single Convex transaction closes the concurrent-
    // authorize race that would otherwise let two parallel flows leave
    // overlapping valid token pairs behind.
    //
    // On any validation failure (INVALID_AUTH_CODE, CLIENT_ID_MISMATCH,
    // REDIRECT_URI_MISMATCH, PKCE_MISMATCH), the mutation throws before
    // patching `used: true`, so the caller can retry with the correct
    // parameters. The HTTP layer normalises all of these to OAuth
    // `invalid_grant` on the wire per RFC 6749 §5.2.
    const prep = await ctx.runMutation(internal.oauth.tokens.consumeCodeAndPrepareSession, {
      code: args.code,
      clientId: args.clientId,
      clientName: args.clientName ?? 'External MCP client',
      redirectUri: args.redirectUri,
      expectedChallenge,
    })

    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.issueAccessToken, {
      token: accessToken,
      clientId: prep.code.clientId,
      userId: prep.code.userId,
      sessionId: prep.sessionId,
      scope: prep.code.scope,
    })
    await ctx.runMutation(internal.oauth.tokens.issueRefreshToken, {
      token: refreshToken,
      clientId: prep.code.clientId,
      userId: prep.code.userId,
      sessionId: prep.sessionId,
      scope: prep.code.scope,
    })
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: prep.code.scope,
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
