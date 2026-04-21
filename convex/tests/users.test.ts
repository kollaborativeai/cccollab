import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema.js'
import { api } from '../_generated/api.js'

const modules = import.meta.glob('../**/*.*s')

describe('users', () => {
  it('getOrCreateByClerk inserts on first call, updates on second', async () => {
    const t = convexTest(schema, modules)
    const a = await t.mutation(api.users.getOrCreateByClerk, {
      clerkId: 'u1',
      email: 'alice@example.com',
      displayName: 'Alice',
    })
    const b = await t.mutation(api.users.getOrCreateByClerk, {
      clerkId: 'u1',
      email: 'alice@example.com',
      displayName: 'Alice Renamed',
    })
    expect(a).toBe(b)
    const row = await t.query(api.users.getById, { userId: a })
    expect(row?.displayName).toBe('Alice Renamed')
  })

  it('getByClerkId returns null if not found', async () => {
    const t = convexTest(schema, modules)
    const row = await t.query(api.users.getByClerkId, { clerkId: 'ghost' })
    expect(row).toBeNull()
  })
})
