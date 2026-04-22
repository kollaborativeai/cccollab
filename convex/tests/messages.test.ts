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
    ).rejects.toThrow(/NOT_IN_TOPIC/)
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
    ).rejects.toThrow(/DM_NO_SHARED_CHANNEL/)
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
    ).rejects.toThrow(/DM_RECIPIENT_AMBIGUOUS/)
  })
})

describe('messages.listByTopic archived-topic filter', () => {
  it('returns empty once the topic is archived, even for members who were subscribed', async () => {
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
    await asStefan.mutation(api.messages.mutations.sendToTopic, { sessionId, topicId, text: 'first' })
    expect((await asStefan.query(api.messages.queries.listByTopic, { topicId })).length).toBe(1)
    await asStefan.mutation(api.topics.mutations.archive, { sessionId, topicId })
    expect(await asStefan.query(api.messages.queries.listByTopic, { topicId })).toEqual([])
  })

  it('returns messages again after the topic is unarchived', async () => {
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
    await asStefan.mutation(api.messages.mutations.sendToTopic, { sessionId, topicId, text: 'first' })
    await asStefan.mutation(api.topics.mutations.archive, { sessionId, topicId })
    expect(await asStefan.query(api.messages.queries.listByTopic, { topicId })).toEqual([])
    await asStefan.mutation(api.topics.mutations.unarchive, { sessionId, topicId })
    expect((await asStefan.query(api.messages.queries.listByTopic, { topicId })).length).toBe(1)
  })
})

describe('messages.listByTopic with sinceTs cursor', () => {
  it('returns messages at the cutoff timestamp (inclusive) so same-ms rows are not dropped', async () => {
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
    const channelId = (await t.run(async (ctx) => ctx.db.get(topicId)))!.channelId

    // Force two inserts at exactly the same `ts`. The bug-before-fix: a
    // client asking for messages `sinceTs=now` after delivering one of the
    // two would silently drop the other on reconnect.
    const now = 1700000000000
    await t.run(async (ctx) => {
      await ctx.db.insert('messages', {
        kind: 'topic',
        topicId,
        channelId,
        fromSessionId: sessionId,
        fromUserId: userId,
        text: 'a',
        ts: now,
      })
      await ctx.db.insert('messages', {
        kind: 'topic',
        topicId,
        channelId,
        fromSessionId: sessionId,
        fromUserId: userId,
        text: 'b',
        ts: now,
      })
    })

    const rows = await asStefan.query(api.messages.queries.listByTopic, { topicId, sinceTs: now })
    expect(rows.map((r) => r.text).sort()).toEqual(['a', 'b'])
  })

  it('listByChannel is also inclusive on its sinceTs cursor', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    const { channelId } = await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })

    const now = 1700000000000
    await t.run(async (ctx) => {
      await ctx.db.insert('messages', {
        kind: 'broadcast',
        channelId,
        fromSessionId: sessionId,
        fromUserId: userId,
        text: 'a',
        ts: now,
      })
      await ctx.db.insert('messages', {
        kind: 'broadcast',
        channelId,
        fromSessionId: sessionId,
        fromUserId: userId,
        text: 'b',
        ts: now,
      })
    })
    const rows = await asStefan.query(api.messages.queries.listByChannel, { channelId, sinceTs: now })
    expect(rows.map((r) => r.text).sort()).toEqual(['a', 'b'])
  })

  it('listDirectMessagesForSession is also inclusive on its sinceTs cursor', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    const asBob = t.withIdentity(identityFor(bob))
    const aliceSession = await asAlice.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const bobSession = await asBob.mutation(api.sessions.mutations.introduce, { sessionName: 'b' })
    await asAlice.mutation(api.channels.mutations.join, { sessionId: aliceSession, channel: 'eng' })
    await asBob.mutation(api.channels.mutations.join, { sessionId: bobSession, channel: 'eng' })

    const now = 1700000000000
    await t.run(async (ctx) => {
      await ctx.db.insert('messages', {
        kind: 'direct',
        fromSessionId: aliceSession,
        fromUserId: alice,
        toSessionId: bobSession,
        text: 'dm1',
        ts: now,
      })
      await ctx.db.insert('messages', {
        kind: 'direct',
        fromSessionId: aliceSession,
        fromUserId: alice,
        toSessionId: bobSession,
        text: 'dm2',
        ts: now,
      })
    })
    const inbox = await asBob.query(api.messages.queries.listDirectMessagesForSession, {
      sessionId: bobSession,
      sinceTs: now,
    })
    expect(inbox.map((m) => m.text).sort()).toEqual(['dm1', 'dm2'])
  })
})

describe('messages.ackChannel + listByChannel per-session cursor (duplicate-broadcast suppression)', () => {
  it("listByChannel filters out broadcasts with ts <= the session's ackChannel cursor", async () => {
    // Bug D regression: on every MCP restart the reactive subscribe
    // re-delivers the entire channel history because there's no
    // per-session high-water-mark. The fix moves the cursor to the
    // server: `listByChannel({sessionId, channelId})` reads the session's
    // cursor; `ackChannel({sessionId, channelId, ts})` bumps it. New
    // subscribe after an ack must skip the acked message.
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    const { channelId } = await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })

    await asStefan.mutation(api.messages.mutations.sendToChannel, {
      sessionId,
      channel: 'eng',
      text: 'first',
    })
    await asStefan.mutation(api.messages.mutations.sendToChannel, {
      sessionId,
      channel: 'eng',
      text: 'second',
    })

    // Without any ack, listByChannel returns both (current behaviour
    // preserved when no sessionId is passed).
    const before = await asStefan.query(api.messages.queries.listByChannel, { channelId })
    expect(before.map((m) => m.text)).toEqual(['first', 'second'])

    // Ack up to the first message's ts. The second is strictly newer.
    const firstTs = before[0]!.ts
    await asStefan.mutation(api.messages.mutations.ackChannel, { sessionId, channelId, ts: firstTs })

    // With sessionId passed, the query uses the stored cursor and skips
    // the acked message.
    const after = await asStefan.query(api.messages.queries.listByChannel, { channelId, sessionId })
    expect(after.map((m) => m.text)).toEqual(['second'])

    // Without sessionId, the legacy call still returns the full set.
    const unfiltered = await asStefan.query(api.messages.queries.listByChannel, { channelId })
    expect(unfiltered.map((m) => m.text)).toEqual(['first', 'second'])
  })

  it('ackChannel is monotonic (ts older than the stored cursor is a no-op)', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    const { channelId } = await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })

    await asStefan.mutation(api.messages.mutations.sendToChannel, { sessionId, channel: 'eng', text: 'a' })
    await asStefan.mutation(api.messages.mutations.sendToChannel, { sessionId, channel: 'eng', text: 'b' })
    const all = await asStefan.query(api.messages.queries.listByChannel, { channelId })
    const [aRow, bRow] = all

    // Ack to b (later), then try to regress to a (earlier). Must not
    // reduce the cursor.
    await asStefan.mutation(api.messages.mutations.ackChannel, { sessionId, channelId, ts: bRow!.ts })
    await asStefan.mutation(api.messages.mutations.ackChannel, { sessionId, channelId, ts: aRow!.ts })

    const after = await asStefan.query(api.messages.queries.listByChannel, { channelId, sessionId })
    expect(after.map((m) => m.text)).toEqual([])
  })

  it("ackChannel is per-session: one session's cursor does not affect another", async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionA = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const sessionB = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 'b' })
    const { channelId } = await asStefan.mutation(api.channels.mutations.join, { sessionId: sessionA, channel: 'eng' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId: sessionB, channel: 'eng' })

    await asStefan.mutation(api.messages.mutations.sendToChannel, {
      sessionId: sessionA,
      channel: 'eng',
      text: 'msg',
    })
    const rows = await asStefan.query(api.messages.queries.listByChannel, { channelId })
    const onlyTs = rows[0]!.ts

    // sessionA acks; sessionB has not acked.
    await asStefan.mutation(api.messages.mutations.ackChannel, { sessionId: sessionA, channelId, ts: onlyTs })

    const aView = await asStefan.query(api.messages.queries.listByChannel, { channelId, sessionId: sessionA })
    const bView = await asStefan.query(api.messages.queries.listByChannel, { channelId, sessionId: sessionB })
    expect(aView.map((m) => m.text)).toEqual([])
    expect(bView.map((m) => m.text)).toEqual(['msg'])
  })

  it('ackChannel refuses to update a cursor for a session the caller does not own', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    const asBob = t.withIdentity(identityFor(bob))
    const aliceSession = await asAlice.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const bobSession = await asBob.mutation(api.sessions.mutations.introduce, { sessionName: 'b' })
    const { channelId } = await asAlice.mutation(api.channels.mutations.join, {
      sessionId: aliceSession,
      channel: 'eng',
    })
    await asBob.mutation(api.channels.mutations.join, { sessionId: bobSession, channel: 'eng' })

    // Alice tries to move Bob's cursor. Must throw.
    await expect(
      asAlice.mutation(api.messages.mutations.ackChannel, { sessionId: bobSession, channelId, ts: 1 }),
    ).rejects.toThrow(/ACK_SESSION_NOT_OWNED|ownership|forbidden/i)
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
