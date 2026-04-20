import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `users` table.
 *
 * Populated by Convex Auth through the OAuth flow. A user row is inserted or
 * updated by the `createOrUpdateUser` callback in `convex/auth.ts` after
 * Google has verified the email. See `convex/auth.ts` for the domain
 * allow-list rejecting non-`@flatout.solutions` sign-ins.
 *
 * Field semantics:
 * - `name`: the display name Google returns; optional because Google Workspace
 *   accounts with only an email may not supply one.
 * - `email`: the email Google returns. Optional at the schema level only to
 *   satisfy Convex Auth's `authTables` contract; our `createOrUpdateUser`
 *   callback rejects sign-ins without one.
 * - `image`: profile picture URL.
 * - `emailVerificationTime`: epoch ms written by Convex Auth when the email is
 *   confirmed verified by the IdP. Google always returns verified emails, so
 *   in practice this is populated on first sign-in.
 */
export const usersTable = defineTable({
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  image: v.optional(v.string()),
  emailVerificationTime: v.optional(v.number()),
}).index('email', ['email'])
