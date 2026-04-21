import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema.js'
import { api } from '../_generated/api.js'

const modules = import.meta.glob('../**/*.*s')

describe('channels', () => {
  it('getOrCreate is idempotent by name', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, {
      clerkId: 'u',
      displayName: 'U',
    })
    const a = await t.mutation(api.channels.getOrCreate, { name: 'general', creatorUserId: userId })
    const b = await t.mutation(api.channels.getOrCreate, { name: 'general', creatorUserId: userId })
    expect(a).toBe(b)
  })

  it('join + listForUser reflects membership', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, {
      clerkId: 'u',
      displayName: 'U',
    })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: userId })
    await t.mutation(api.channels.join, { channelId, userId })
    const channels = await t.query(api.channels.listForUser, { userId })
    expect(channels.map((c) => c.name)).toEqual(['eng'])
  })

  it('join is idempotent', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, {
      clerkId: 'u',
      displayName: 'U',
    })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: userId })
    const a = await t.mutation(api.channels.join, { channelId, userId })
    const b = await t.mutation(api.channels.join, { channelId, userId })
    expect(a).toBe(b)
  })
})
