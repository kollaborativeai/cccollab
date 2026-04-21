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

    // PKCE hash + random token generation happen in the action:
    // `crypto.subtle.digest` is not available in the Convex mutation
    // isolate; the action runtime is the only one with full Web Crypto.
    // `crypto.getRandomValues` IS available in mutations, but the action
    // holds the tokens to return to the HTTP client anyway, so we
    // generate them here and hand them to the mutation as opaque
    // strings. That keeps the mutation free of any CSPRNG dependency.
    const expectedChallenge = await sha256Base64Url(args.codeVerifier)
    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)

    // ONE atomic mutation does: validate + consume + revoke prior tokens
    // for (userId, clientId) + get-or-create synthetic session + insert
    // the two new token rows. Keeping every read + write in a single
    // Convex transaction is what guarantees OCC serialises two parallel
    // authorize flows for the same (userId, clientId) — the later flow's
    // revoke step observes the earlier flow's newly-inserted tokens and
    // revokes them, or the two conflict on the shared index and the
    // later retries with the earlier's writes visible.
    const result = await ctx.runMutation(internal.oauth.tokens.exchangeCodeForTokens, {
      code: args.code,
      clientId: args.clientId,
      clientName: args.clientName ?? 'External MCP client',
      redirectUri: args.redirectUri,
      expectedChallenge,
      accessToken,
      refreshToken,
    })

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: result.scope,
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
    const accessToken = randomToken(32)
    const newRefreshToken = randomToken(32)
    // Atomic: consume old refresh token + insert new pair in one tx.
    const result = await ctx.runMutation(internal.oauth.tokens.rotateRefreshToken, {
      oldRefreshToken: args.refreshToken,
      clientId: args.clientId,
      accessToken,
      refreshToken: newRefreshToken,
    })
    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: result.scope,
    }
  },
})
