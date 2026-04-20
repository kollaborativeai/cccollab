import type { TestConvex } from 'convex-test'

import type { Id } from '../_generated/dataModel'
import type schema from '../schema'

/**
 * Insert a seed user row and return its id. Convex Auth owns the
 * `createOrUpdateUser` callback in production, but for backend unit tests
 * we bypass the OAuth flow and seed users directly. The shape matches
 * what our `createOrUpdateUser` callback would write on a real sign-in.
 */
export async function seedUser(t: TestConvex<typeof schema>, email: string, name?: string): Promise<Id<'users'>> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert('users', {
      email,
      name: name ?? email.split('@')[0],
    })
  })
}

/**
 * Create a `TestConvex` identity for the given userId.
 *
 * `@convex-dev/auth`'s `getAuthUserId` extracts the userId from
 * `identity.subject.split("|")[0]`, so we mirror that format. The other
 * fields are fabricated; tests may override them if they care about the
 * claim contents.
 */
export function identityFor(userId: Id<'users'>): {
  subject: string
  tokenIdentifier: string
  issuer: string
} {
  return {
    subject: userId,
    tokenIdentifier: `test|${userId}`,
    issuer: 'test',
  }
}
