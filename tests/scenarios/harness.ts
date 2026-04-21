import { convexTest } from 'convex-test'
import schema from '../../convex/schema.js'
import { api } from '../../convex/_generated/api.js'
import type { Id } from '../../convex/_generated/dataModel.js'

// Loaded at module eval time so vitest's glob works.
export const convexModules = import.meta.glob('../../convex/**/*.*s')

/**
 * Scenario-level test harness. Wraps `convex-test` with a fake-identity helper
 * and a `ensureUser` shortcut. Identity does not travel through Convex's auth
 * layer (Clerk); instead we seed users directly and call functions with the
 * resulting Convex userId.
 */
export function makeHarness() {
  const t = convexTest(schema, convexModules)

  async function ensureUser(clerkId: string, name: string, email?: string): Promise<Id<'users'>> {
    return await t.mutation(api.users.getOrCreateByClerk, {
      clerkId,
      displayName: name,
      email,
    })
  }

  return { t, ensureUser }
}
