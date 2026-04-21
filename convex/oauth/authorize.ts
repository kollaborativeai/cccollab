import { v } from 'convex/values'
import { mutation } from '../_generated/server.js'
import { internal } from '../_generated/api.js'
import { randomToken } from '../lib/crypto.js'

export const ALLOWED_SCOPES = ['cccollab:topics.rw'] as const

export function isAllowedScope(scope: string): boolean {
  const requested = scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (requested.length === 0) return false
  for (const s of requested) {
    if (!(ALLOWED_SCOPES as readonly string[]).includes(s)) return false
  }
  return true
}

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
    if (!isAllowedScope(args.scope)) {
      throw new Error(`invalid scope; allowed: ${ALLOWED_SCOPES.join(' ')}`)
    }
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
