import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'

import { api } from '../_generated/api'
import schema from '../schema'
import { identityFor, seedUser } from './helpers'

const modules = import.meta.glob('../**/*.ts')

describe('topics.start', () => {
  it('creates a topic and implicit creator membership', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })

    const { topicId } = await asStefan.mutation(api.topics.mutations.start, {
      sessionId,
      channel: 'eng',
      topic: 'build-pipeline',
    })

    const state = await t.run(async (ctx) => ({
      topic: await ctx.db.get(topicId),
      members: await ctx.db
        .query('topicMembers')
        .withIndex('by_topic', (q) => q.eq('topicId', topicId))
        .collect(),
    }))
    expect(state.topic?.state).toBe('active')
    expect(state.topic?.normalizedTopic).toBe('build-pipeline')
    expect(state.members.length).toBe(1)
  })

  it('rejects duplicate active topic names in the same channel', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    await asStefan.mutation(api.topics.mutations.start, {
      sessionId,
      channel: 'eng',
      topic: 'Build Pipeline',
    })
    await expect(
      asStefan.mutation(api.topics.mutations.start, {
        sessionId,
        channel: 'eng',
        topic: 'build pipeline',
      }),
    ).rejects.toThrow(/TOPIC_NAME_CONFLICT/)
  })

  it('tolerates an archived topic with the same name', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    const { topicId: archivedId } = await asStefan.mutation(api.topics.mutations.start, {
      sessionId,
      channel: 'eng',
      topic: 'build-pipeline',
    })
    await asStefan.mutation(api.topics.mutations.archive, { sessionId, topicId: archivedId })
    const { topicId: newId } = await asStefan.mutation(api.topics.mutations.start, {
      sessionId,
      channel: 'eng',
      topic: 'build-pipeline',
    })
    expect(newId).not.toBe(archivedId)
  })

  it('rejects start from non-subscribed caller', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await expect(
      asStefan.mutation(api.topics.mutations.start, { sessionId, channel: 'eng', topic: 't' }),
    ).rejects.toThrow(/CHANNEL_NOT_FOUND/)
  })
})

describe('topics.unarchive', () => {
  it('refuses to resurrect a topic whose name is already taken by an active one', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    const { topicId: archivedId } = await asStefan.mutation(api.topics.mutations.start, {
      sessionId,
      channel: 'eng',
      topic: 'foo',
    })
    await asStefan.mutation(api.topics.mutations.archive, { sessionId, topicId: archivedId })
    await asStefan.mutation(api.topics.mutations.start, { sessionId, channel: 'eng', topic: 'foo' })
    await expect(asStefan.mutation(api.topics.mutations.unarchive, { sessionId, topicId: archivedId })).rejects.toThrow(
      /TOPIC_NAME_CONFLICT/,
    )
  })
})

describe('topics.listByChannel', () => {
  it('returns empty when the caller is not subscribed', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    expect(await asStefan.query(api.topics.queries.listByChannel, { channel: 'eng' })).toEqual([])
  })

  it('excludes archived topics by default and includes them when asked', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    const { topicId } = await asStefan.mutation(api.topics.mutations.start, {
      sessionId,
      channel: 'eng',
      topic: 't',
    })
    await asStefan.mutation(api.topics.mutations.archive, { sessionId, topicId })
    const withoutArchived = await asStefan.query(api.topics.queries.listByChannel, { channel: 'eng' })
    expect(withoutArchived).toEqual([])
    const withArchived = await asStefan.query(api.topics.queries.listByChannel, {
      channel: 'eng',
      includeArchived: true,
    })
    expect(withArchived.length).toBe(1)
  })
})
