import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema.js'
import { api, internal } from '../_generated/api.js'

const modules = import.meta.glob('../**/*.*s')

describe('messages', () => {
  it('send stores message with attribution fields', async () => {
    const t = convexTest(schema, modules)
    const u = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'User' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: u })
    const topicId = await t.mutation(api.topics.create, { name: 't', channelId, creatorUserId: u })
    const messageId = await t.mutation(internal.messages.send, {
      topicId,
      authorType: 'external',
      authorKey: 'u',
      authorName: 'User',
      text: 'hello',
    })
    const list = await t.query(api.messages.listForTopic, { topicId })
    expect(list).toMatchObject([{ _id: messageId, authorType: 'external', authorName: 'User', text: 'hello' }])
  })

  it('sendAsUser succeeds when user is a member of the topic', async () => {
    const t = convexTest(schema, modules)
    const u = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'User' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: u })
    const topicId = await t.mutation(api.topics.create, { name: 't', channelId, creatorUserId: u })
    const messageId = await t.mutation(api.messages.sendAsUser, {
      topicId,
      userId: u,
      text: 'self-sent',
    })
    const list = await t.query(api.messages.listForTopic, { topicId })
    expect(list).toMatchObject([{ _id: messageId, authorType: 'external', authorName: 'User', text: 'self-sent' }])
  })

  it('sendAsUser rejects non-members', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'A' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'B' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 't', channelId, creatorUserId: alice })
    await expect(t.mutation(api.messages.sendAsUser, { topicId, userId: bob, text: 'intruder' })).rejects.toThrow(
      /not a member/i,
    )
  })

  it('listRecent returns hydrated messages with topicName + channelName (chronological)', async () => {
    const t = convexTest(schema, modules)
    const u = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'User' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: u })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: u })
    for (let i = 0; i < 5; i++) {
      await t.mutation(internal.messages.send, {
        topicId,
        authorType: 'external',
        authorKey: 'u',
        authorName: 'User',
        text: `msg ${i}`,
      })
    }
    const recent = await t.query(api.messages.listRecent, {})
    expect(recent.map((m) => m.text)).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4'])
    expect(recent.every((m) => m.topicName === 'design' && m.channelName === 'eng')).toBe(true)
  })
})
