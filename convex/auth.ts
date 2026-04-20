import Google from '@auth/core/providers/google'
import { convexAuth } from '@convex-dev/auth/server'
import { ConvexError } from 'convex/values'

import { isAllowedEmail } from './allowlist'

/**
 * Convex Auth entry point.
 *
 * Phase 2 wires a Google OAuth provider plus a `createOrUpdateUser` callback
 * that enforces the `@flatout.solutions` domain allow-list at profile time.
 * Sign-ins from any other domain throw a `ConvexError`, which Convex Auth
 * surfaces to the OAuth callback handler as a failed sign-in. No user row is
 * created for rejected emails.
 *
 * Phase 4 will add the `redirect` callback that constrains the post-login
 * destination to the local MCP server's callback URL; until then,
 * `SITE_URL` governs the default redirect and OAuth will fail closed if it
 * isn't set.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google],
  callbacks: {
    async createOrUpdateUser(ctx, args) {
      const email = args.profile.email as string | undefined
      if (!isAllowedEmail(email)) {
        throw new ConvexError({
          code: 'DOMAIN_NOT_ALLOWED',
          message: 'Sign-in is restricted to approved FlatOut domains.',
        })
      }

      if (args.existingUserId) {
        // Refresh the name/image on each sign-in so profile changes in Google
        // propagate without us having to wire a separate user-update flow.
        await ctx.db.patch(args.existingUserId, {
          name: typeof args.profile.name === 'string' ? args.profile.name : undefined,
          email,
          image: typeof args.profile.image === 'string' ? args.profile.image : undefined,
        })
        return args.existingUserId
      }

      return ctx.db.insert('users', {
        name: typeof args.profile.name === 'string' ? args.profile.name : undefined,
        email,
        image: typeof args.profile.image === 'string' ? args.profile.image : undefined,
      })
    },
  },
})
