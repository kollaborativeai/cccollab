import { ConvexError, v } from 'convex/values'

import { mutation } from '../_generated/server'
import { randomToken, sha256Base64Url } from '../lib/crypto'
import { nowMs } from '../lib/time'

/**
 * RFC 7591 Dynamic Client Registration.
 *
 * Open endpoint — no authentication required. External AI clients POST
 * their name + redirect URIs here and receive a `client_id` (public) or a
 * `client_id` + `client_secret` pair (confidential). The secret is hashed
 * with SHA-256 before storage; the raw secret is returned to the caller
 * exactly once in the registration response.
 *
 * Redirect URIs must be HTTPS except for loopback `127.0.0.1`. `localhost`
 * is **not** accepted — it introduces an exploitable window where any
 * local process that can bind a port first can receive the OAuth code.
 * See the CCC-3 review comment for context.
 */
export type RegisterResult = {
  client_id: string
  client_secret?: string
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: 'none' | 'client_secret_post'
}

export const register = mutation({
  args: {
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod: v.union(v.literal('none'), v.literal('client_secret_post')),
  },
  handler: async (ctx, args): Promise<RegisterResult> => {
    if (args.redirectUris.length === 0) {
      throw new ConvexError({ code: 'INVALID_CLIENT_METADATA', message: 'redirect_uris must not be empty' })
    }
    for (const uri of args.redirectUris) validateRedirectUri(uri)

    const clientId = randomToken(16)
    let clientSecret: string | undefined
    let clientSecretHash: string | undefined
    if (args.tokenEndpointAuthMethod === 'client_secret_post') {
      clientSecret = randomToken(32)
      clientSecretHash = await sha256Base64Url(clientSecret)
    }
    await ctx.db.insert('oauthClients', {
      clientId,
      clientName: args.clientName,
      redirectUris: args.redirectUris,
      tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
      clientSecretHash,
      createdAt: nowMs(),
    })
    return {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: args.clientName,
      redirect_uris: args.redirectUris,
      token_endpoint_auth_method: args.tokenEndpointAuthMethod,
    }
  },
})

function validateRedirectUri(uri: string): void {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new ConvexError({ code: 'INVALID_CLIENT_METADATA', message: `invalid redirect_uri: ${uri}` })
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConvexError({
      code: 'INVALID_CLIENT_METADATA',
      message: `redirect_uri must not contain userinfo: ${uri}`,
    })
  }
  const isLoopback = parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new ConvexError({
      code: 'INVALID_CLIENT_METADATA',
      message: `redirect_uri must be https or 127.0.0.1: ${uri}`,
    })
  }
}
