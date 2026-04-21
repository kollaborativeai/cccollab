import { v } from 'convex/values'
import { mutation } from '../_generated/server.js'
import { randomToken, sha256Base64Url } from '../lib/crypto.js'

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
      throw new Error('redirect_uris must not be empty')
    }
    for (const uri of args.redirectUris) {
      validateRedirectUri(uri)
    }
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
    throw new Error(`invalid redirect_uri: ${uri}`)
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new Error(`redirect_uri must be https or localhost: ${uri}`)
  }
}
