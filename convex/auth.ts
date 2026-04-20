import Google from '@auth/core/providers/google'
import { convexAuth } from '@convex-dev/auth/server'
import { ConvexError } from 'convex/values'

import { isAllowedEmail } from './allowlist'
import { isAllowedRedirect } from './redirect'

/**
 * Convex Auth entry point.
 *
 * Phase 2 wired a Google OAuth provider plus a `createOrUpdateUser`
 * callback that enforces the `@flatout.solutions` domain allow-list at
 * profile time. Sign-ins from any other domain throw a `ConvexError`,
 * which Convex Auth surfaces to the OAuth callback handler as a failed
 * sign-in. No user row is created for rejected emails.
 *
 * Phase 4 (this file) adds the `redirect` callback that constrains the
 * post-login destination to loopback URLs on the `cccollab-oauth-callback`
 * path - the local MCP server's ephemeral listener. See
 * `convex/redirect.ts` for the narrow allow rule (http loopback,
 * specific path, no query / hash, IPv6 excluded).
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

    async redirect({ redirectTo }) {
      if (!isAllowedRedirect(redirectTo)) {
        throw new ConvexError({
          code: 'INVALID_REDIRECT',
          message: `Redirect to "${redirectTo}" is not permitted.`,
        })
      }
      return redirectTo
    },
  },
})
