import { v } from 'convex/values'
import { mutation } from '../_generated/server.js'
import { internal } from '../_generated/api.js'
import { randomToken } from '../lib/crypto.js'

export const issueAuthCode = mutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.literal('S256'),
    scope: v.string(),
    userId: v.id('users'),
  },
  handler: async (ctx, args): Promise<{ code: string }> => {
    const client = await ctx.db
      .query('oauthClients')
      .withIndex('by_clientId', (q) => q.eq('clientId', args.clientId))
      .unique()
    if (!client) throw new Error('unknown client')
    if (!client.redirectUris.includes(args.redirectUri)) {
      throw new Error('redirect_uri not registered for client')
    }
    if (!args.codeChallenge) throw new Error('code_challenge required')
    const code = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.storeAuthCode, {
      code,
      clientId: args.clientId,
      userId: args.userId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: args.scope,
    })
    return { code }
  },
})
