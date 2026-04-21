import { ConvexError, v } from 'convex/values'

import { internal } from '../_generated/api'
import { randomToken } from '../lib/crypto'
import { authenticatedMutation } from '../utils/auth'
import { parseScope } from './scopes'

/**
 * Authorization-code issuance (RFC 6749 + PKCE).
 *
 * Called from the `/authorize` HTTP route after the user has signed in via
 * Convex Auth (Google OAuth through `@convex-dev/auth`). The external AI
 * client has sent the caller to `/authorize?response_type=code&...&code_challenge=...`;
 * we verify the client is registered + the redirect_uri matches + the scope
 * is permitted, then mint a short-lived single-use code bound to (userId,
 * clientId, redirectUri, code_challenge).
 *
 * The `/authorize` HTTP handler is responsible for the 302 back to the
 * `redirect_uri` with `?code=...&state=...` query params; this mutation
 * only produces the code itself.
 */
export const issueAuthCode = authenticatedMutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.literal('S256'),
    scope: v.string(),
  },
  handler: async (ctx, args): Promise<{ code: string }> => {
    const client = await ctx.db
      .query('oauthClients')
      .withIndex('by_clientId', (q) => q.eq('clientId', args.clientId))
      .unique()
    if (!client) {
      throw new ConvexError({ code: 'UNKNOWN_CLIENT', message: 'client_id is not registered' })
    }
    if (!client.redirectUris.includes(args.redirectUri)) {
      throw new ConvexError({
        code: 'INVALID_REDIRECT_URI',
        message: 'redirect_uri is not registered for this client',
      })
    }
    if (!args.codeChallenge) {
      throw new ConvexError({ code: 'INVALID_REQUEST', message: 'code_challenge required' })
    }
    const parsed = parseScope(args.scope)
    if (parsed === null) {
      throw new ConvexError({ code: 'INVALID_SCOPE', message: `unknown scope: ${args.scope}` })
    }
    const code = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.storeAuthCode, {
      code,
      clientId: args.clientId,
      userId: ctx.userId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: parsed.join(' '),
    })
    return { code }
  },
})
