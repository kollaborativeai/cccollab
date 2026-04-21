import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema.js'
import { api } from '../_generated/api.js'

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
    await t.mutation(api.messages.send, {
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
