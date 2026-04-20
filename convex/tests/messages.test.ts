import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'

import { api } from '../_generated/api'
import schema from '../schema'
import { identityFor, seedUser } from './helpers'

const modules = import.meta.glob('../**/*.ts')

describe('messages.sendToTopic', () => {
  it('writes a topic message and is readable via listByTopic', async () => {
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
    await asStefan.mutation(api.messages.mutations.sendToTopic, { sessionId, topicId, text: 'hello' })
    const messages = await asStefan.query(api.messages.queries.listByTopic, { topicId })
    expect(messages.length).toBe(1)
    expect(messages[0]!.text).toBe('hello')
    expect(messages[0]!.kind).toBe('topic')
  })

  it('rejects sending to a topic the caller has not joined', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    const asBob = t.withIdentity(identityFor(bob))
    const aliceSession = await asAlice.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const bobSession = await asBob.mutation(api.sessions.mutations.introduce, { sessionName: 'b' })
    await asAlice.mutation(api.channels.mutations.join, { sessionId: aliceSession, channel: 'eng' })
    await asBob.mutation(api.channels.mutations.join, { sessionId: bobSession, channel: 'eng' })
    const { topicId } = await asAlice.mutation(api.topics.mutations.start, {
      sessionId: aliceSession,
      channel: 'eng',
      topic: 't',
    })
    // Bob is subscribed to eng but has not joined the topic.
    await expect(
      asBob.mutation(api.messages.mutations.sendToTopic, { sessionId: bobSession, topicId, text: 'hi' }),
    ).rejects.toThrowError(/NOT_IN_TOPIC/)
  })
})

describe('messages.sendToChannel', () => {
  it('writes a broadcast and surfaces it via listByChannel', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    const { channelId } = await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    await asStefan.mutation(api.messages.mutations.sendToChannel, {
      sessionId,
      channel: 'eng',
      text: 'annonce',
    })
    const channelFeed = await asStefan.query(api.messages.queries.listByChannel, { channelId })
    expect(channelFeed.length).toBe(1)
    expect(channelFeed[0]!.kind).toBe('broadcast')
  })
})

describe('messages.sendToSession (DM)', () => {
  it('delivers a DM when sender and recipient share a channel', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    const asBob = t.withIdentity(identityFor(bob))
    const aliceSession = await asAlice.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const bobSession = await asBob.mutation(api.sessions.mutations.introduce, { sessionName: 'b' })
    await asAlice.mutation(api.channels.mutations.join, { sessionId: aliceSession, channel: 'eng' })
    await asBob.mutation(api.channels.mutations.join, { sessionId: bobSession, channel: 'eng' })

    const res = await asAlice.mutation(api.messages.mutations.sendToSession, {
      sessionId: aliceSession,
      toSessionName: 'b',
      text: 'psst',
    })
    expect(res.toSessionId).toBe(bobSession)

    const inbox = await asBob.query(api.messages.queries.listDirectMessagesForSession, { sessionId: bobSession })
    expect(inbox.length).toBe(1)
    expect(inbox[0]!.text).toBe('psst')
  })

  it('rejects a DM when sender and recipient share no channel', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    const asBob = t.withIdentity(identityFor(bob))
    const aliceSession = await asAlice.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const bobSession = await asBob.mutation(api.sessions.mutations.introduce, { sessionName: 'b' })
    await asAlice.mutation(api.channels.mutations.join, { sessionId: aliceSession, channel: 'eng' })
    await asBob.mutation(api.channels.mutations.join, { sessionId: bobSession, channel: 'product' })
    await expect(
      asAlice.mutation(api.messages.mutations.sendToSession, {
        sessionId: aliceSession,
        toSessionId: bobSession,
        text: 'hi',
      }),
    ).rejects.toThrowError(/DM_NO_SHARED_CHANNEL/)
  })

  it('errors DM_RECIPIENT_AMBIGUOUS when more than one matching session shares a channel', async () => {
    // Alice sends to session name "architect". Two different users, Bob and
    // Carol, both have a session called "architect", and both share the
    // "eng" channel with Alice. The mutation must refuse to guess.
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const carol = await seedUser(t, 'carol@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    const asBob = t.withIdentity(identityFor(bob))
    const asCarol = t.withIdentity(identityFor(carol))
    const aliceSession = await asAlice.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const bobSession = await asBob.mutation(api.sessions.mutations.introduce, { sessionName: 'architect' })
    const carolSession = await asCarol.mutation(api.sessions.mutations.introduce, { sessionName: 'architect' })
    await asAlice.mutation(api.channels.mutations.join, { sessionId: aliceSession, channel: 'eng' })
    await asBob.mutation(api.channels.mutations.join, { sessionId: bobSession, channel: 'eng' })
    await asCarol.mutation(api.channels.mutations.join, { sessionId: carolSession, channel: 'eng' })
    await expect(
      asAlice.mutation(api.messages.mutations.sendToSession, {
        sessionId: aliceSession,
        toSessionName: 'architect',
        text: 'hi',
      }),
    ).rejects.toThrowError(/DM_RECIPIENT_AMBIGUOUS/)
  })
})

describe('messages.listDirectMessagesForSession', () => {
  it('refuses to surface another user’s DMs', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    const asBob = t.withIdentity(identityFor(bob))
    const aliceSession = await asAlice.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const bobSession = await asBob.mutation(api.sessions.mutations.introduce, { sessionName: 'b' })
    // Alice querying Bob's inbox should return empty (auth leak prevention).
    const leak = await asAlice.query(api.messages.queries.listDirectMessagesForSession, {
      sessionId: bobSession,
    })
    expect(leak).toEqual([])
    // Control: asking about your own session with no DMs returns empty too.
    expect(await asAlice.query(api.messages.queries.listDirectMessagesForSession, { sessionId: aliceSession })).toEqual(
      [],
    )
  })
})
