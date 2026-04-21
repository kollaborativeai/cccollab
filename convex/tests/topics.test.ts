import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema.js'
import { api, internal } from '../_generated/api.js'

const modules = import.meta.glob('../**/*.*s')

describe('topics', () => {
  it('create adds the creator to membership', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, {
      name: 'design',
      channelId,
      creatorUserId: alice,
    })

    const topics = await t.query(api.topics.listForUser, { userId: alice })
    expect(topics.map((topic) => topic._id)).toEqual([topicId])
  })

  it('listForUser returns only topics the user is a member of', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'Bob' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    await t.mutation(api.topics.create, { name: 'alice-only', channelId, creatorUserId: alice })

    expect((await t.query(api.topics.listForUser, { userId: alice })).map((t) => t.name)).toEqual(['alice-only'])
    expect(await t.query(api.topics.listForUser, { userId: bob })).toEqual([])
  })

  it('readForUser returns topic + messages for members; null for non-members', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'Bob' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'dr', channelId, creatorUserId: alice })
    await t.mutation(internal.messages.send, {
      topicId,
      authorType: 'external',
      authorKey: 'a',
      authorName: 'Alice',
      text: 'hi',
    })

    const aliceView = await t.query(api.topics.readForUser, { topicId, userId: alice })
    expect(aliceView?.messages.length).toBe(1)
    expect(aliceView?.topic.name).toBe('dr')

    const bobView = await t.query(api.topics.readForUser, { topicId, userId: bob })
    expect(bobView).toBeNull()
  })

  it('readForUser hides archived topics even from existing members', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'dr', channelId, creatorUserId: alice })

    // Directly mark the topic as archived.
    await t.run(async (ctx) => {
      await ctx.db.patch(topicId, { state: 'archived' })
    })

    const view = await t.query(api.topics.readForUser, { topicId, userId: alice })
    expect(view).toBeNull()

    // And listForUser hides archived too.
    const listed = await t.query(api.topics.listForUser, { userId: alice })
    expect(listed).toEqual([])
  })

  it('readForUser caps messages at 200 and returns them oldest-first', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'dr', channelId, creatorUserId: alice })
    for (let i = 0; i < 250; i++) {
      await t.mutation(internal.messages.send, {
        topicId,
        authorType: 'external',
        authorKey: 'a',
        authorName: 'Alice',
        text: `msg-${i}`,
      })
    }
    const view = await t.query(api.topics.readForUser, { topicId, userId: alice })
    expect(view?.messages.length).toBe(200)
    // The oldest returned message should be msg-50 (250 - 200); newest should be msg-249.
    expect(view?.messages[0]!.text).toBe('msg-50')
    expect(view?.messages[199]!.text).toBe('msg-249')
  })

  it('join makes a user a member and surfaces topic in listForUser', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'Bob' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'dr', channelId, creatorUserId: alice })
    await t.mutation(api.topics.join, { topicId, userId: bob })
    const bobTopics = await t.query(api.topics.listForUser, { userId: bob })
    expect(bobTopics.map((topic) => topic._id)).toEqual([topicId])
  })
})
