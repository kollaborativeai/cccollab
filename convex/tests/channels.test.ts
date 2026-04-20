import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import { ConvexError } from 'convex/values'

import { api } from '../_generated/api'
import schema from '../schema'
import { identityFor, seedUser } from './helpers'

const modules = import.meta.glob('../**/*.ts')

describe('channels.join', () => {
  it('creates channel, channelMembers, and sessionChannels rows', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })

    const res = await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'Eng' })
    expect(res.normalizedName).toBe('eng')

    const state = await t.run(async (ctx) => ({
      channels: await ctx.db.query('channels').collect(),
      members: await ctx.db.query('channelMembers').collect(),
      presence: await ctx.db.query('sessionChannels').collect(),
    }))
    expect(state.channels.length).toBe(1)
    expect(state.channels[0]!.normalizedName).toBe('eng')
    expect(state.members.length).toBe(1)
    expect(state.presence.length).toBe(1)
  })

  it('is idempotent on repeat join', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    const counts = await t.run(async (ctx) => ({
      channels: (await ctx.db.query('channels').collect()).length,
      members: (await ctx.db.query('channelMembers').collect()).length,
      presence: (await ctx.db.query('sessionChannels').collect()).length,
    }))
    expect(counts).toEqual({ channels: 1, members: 1, presence: 1 })
  })

  it('rejects empty channel names', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await expect(asStefan.mutation(api.channels.mutations.join, { sessionId, channel: '  ' })).rejects.toThrow(
      /INVALID_CHANNEL_NAME/,
    )
  })

  it('rejects unauthenticated callers', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    // Create a session row as Stefan so we have a well-formed Id<'sessions'>
    // to pass, then call without any identity attached.
    const sessionId = await t
      .withIdentity(identityFor(userId))
      .mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await expect(t.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })).rejects.toThrow(ConvexError)
  })
})

describe('channels.leave', () => {
  it('removes channelMembers and sessionChannels rows for the caller', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    await asStefan.mutation(api.channels.mutations.leave, { sessionId, channel: 'eng' })
    const counts = await t.run(async (ctx) => ({
      members: (await ctx.db.query('channelMembers').collect()).length,
      presence: (await ctx.db.query('sessionChannels').collect()).length,
    }))
    expect(counts).toEqual({ members: 0, presence: 0 })
  })

  it('is a no-op when the caller was never subscribed', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    const res = await asStefan.mutation(api.channels.mutations.leave, { sessionId, channel: 'eng' })
    expect(res.removed).toBe(false)
  })
})

describe('channels.listAll', () => {
  it('returns broker-global channel list with counts', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'product' })

    const channels = await asStefan.query(api.channels.queries.listAll, {})
    const names = channels.map((c) => c.normalizedName).sort()
    expect(names).toEqual(['eng', 'product'])
    for (const c of channels) {
      expect(c.subscriberCount).toBe(1)
      expect(c.presentSessionCount).toBe(1)
    }
  })
})

describe('channels.listForUser', () => {
  it('returns empty when the user has no subscriptions', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    expect(await asStefan.query(api.channels.queries.listForUser, {})).toEqual([])
  })

  it('returns each joined channel once regardless of session count', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const first = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 'laptop' })
    const second = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 'desktop' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId: first, channel: 'eng' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId: second, channel: 'eng' })
    const results = await asStefan.query(api.channels.queries.listForUser, {})
    expect(results.length).toBe(1)
    expect(results[0]!.normalizedName).toBe('eng')
  })
})
