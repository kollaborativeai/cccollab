import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import { ConvexError } from 'convex/values'

import { api } from '../_generated/api'
import schema from '../schema'
import { identityFor, seedUser } from './helpers'

// Load every convex function file so convexTest can dispatch against them.
const modules = import.meta.glob('../**/*.ts')

describe('sessions.introduce', () => {
  it('creates a new session row for the caller', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions', 'Stefan')
    const sessionId = await t.withIdentity(identityFor(userId)).mutation(api.sessions.mutations.introduce, {
      sessionName: 'architect',
      objective: 'plan the refactor',
    })
    expect(sessionId).toBeDefined()

    // Re-read the row and verify shape.
    const session = await t.run(async (ctx) => ctx.db.get(sessionId))
    expect(session).toMatchObject({
      userId,
      sessionName: 'architect',
      objective: 'plan the refactor',
    })
  })

  it('returns the existing row when the same user re-introduces', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const first = await asStefan.mutation(api.sessions.mutations.introduce, {
      sessionName: 'architect',
    })
    const second = await asStefan.mutation(api.sessions.mutations.introduce, {
      sessionName: 'architect',
      objective: 'updated objective',
    })
    expect(second).toBe(first)

    const session = await t.run(async (ctx) => ctx.db.get(first))
    expect(session?.objective).toBe('updated objective')
  })

  it('allows two users to each have a session called "architect"', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const aliceSession = await t
      .withIdentity(identityFor(alice))
      .mutation(api.sessions.mutations.introduce, { sessionName: 'architect' })
    const bobSession = await t
      .withIdentity(identityFor(bob))
      .mutation(api.sessions.mutations.introduce, { sessionName: 'architect' })
    expect(aliceSession).not.toBe(bobSession)
  })

  it('rejects unauthenticated callers with UNAUTHENTICATED', async () => {
    const t = convexTest(schema, modules)
    await expect(t.mutation(api.sessions.mutations.introduce, { sessionName: 'architect' })).rejects.toThrow(
      ConvexError,
    )
  })

  it('rejects empty session names', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    await expect(
      t.withIdentity(identityFor(userId)).mutation(api.sessions.mutations.introduce, { sessionName: '  ' }),
    ).rejects.toThrow(/INVALID_SESSION_NAME|non-empty/i)
  })
})

describe('sessions.updateLastSeen', () => {
  it('bumps lastSeenAt for the caller', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    const before = await t.run(async (ctx) => ctx.db.get(sessionId))
    await new Promise<void>((r) => setTimeout(r, 5))
    await asStefan.mutation(api.sessions.mutations.updateLastSeen, { sessionId })
    const after = await t.run(async (ctx) => ctx.db.get(sessionId))
    expect(after!.lastSeenAt).toBeGreaterThan(before!.lastSeenAt)
  })

  it('rejects updates to a session owned by another user', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const aliceSession = await t
      .withIdentity(identityFor(alice))
      .mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    await expect(
      t.withIdentity(identityFor(bob)).mutation(api.sessions.mutations.updateLastSeen, { sessionId: aliceSession }),
    ).rejects.toThrow(/NOT_OWNER/)
  })
})

describe('sessions.remove', () => {
  it('deletes the session and its sessionChannels and topicMembers rows', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions')
    const asStefan = t.withIdentity(identityFor(userId))
    const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
    await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })

    // Precondition: one sessionChannels row exists.
    const before = await t.run(async (ctx) =>
      ctx.db
        .query('sessionChannels')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect(),
    )
    expect(before.length).toBe(1)

    await asStefan.mutation(api.sessions.mutations.remove, { sessionId })

    const after = await t.run(async (ctx) => ({
      session: await ctx.db.get(sessionId),
      presence: await ctx.db
        .query('sessionChannels')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect(),
    }))
    expect(after.session).toBeNull()
    expect(after.presence.length).toBe(0)
  })
})

describe('sessions.whoami', () => {
  it('returns the signed-in user shape', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'stefan@flatout.solutions', 'Stefan')
    const whoami = await t.withIdentity(identityFor(userId)).query(api.sessions.queries.whoami, {})
    expect(whoami).toMatchObject({ userId, email: 'stefan@flatout.solutions', name: 'Stefan' })
  })

  it('rejects unauthenticated callers', async () => {
    const t = convexTest(schema, modules)
    await expect(t.query(api.sessions.queries.whoami, {})).rejects.toThrow(ConvexError)
  })
})

describe('sessions.listByChannel', () => {
  it('returns only sessions currently present in shared channels', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const bob = await seedUser(t, 'bob@flatout.solutions')
    const carol = await seedUser(t, 'carol@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    const asBob = t.withIdentity(identityFor(bob))
    const asCarol = t.withIdentity(identityFor(carol))

    const aliceSession = await asAlice.mutation(api.sessions.mutations.introduce, { sessionName: 'a' })
    const bobSession = await asBob.mutation(api.sessions.mutations.introduce, { sessionName: 'b' })
    const carolSession = await asCarol.mutation(api.sessions.mutations.introduce, { sessionName: 'c' })
    await asAlice.mutation(api.channels.mutations.join, { sessionId: aliceSession, channel: 'eng' })
    await asBob.mutation(api.channels.mutations.join, { sessionId: bobSession, channel: 'eng' })
    await asCarol.mutation(api.channels.mutations.join, { sessionId: carolSession, channel: 'product' })

    const sessions = await asAlice.query(api.sessions.queries.listByChannel, { channel: 'eng' })
    const ids = sessions.map((s) => s._id).sort()
    expect(ids).toEqual([aliceSession, bobSession].sort())
  })

  it('returns empty when the caller is not subscribed to the requested channel', async () => {
    const t = convexTest(schema, modules)
    const alice = await seedUser(t, 'alice@flatout.solutions')
    const asAlice = t.withIdentity(identityFor(alice))
    expect(await asAlice.query(api.sessions.queries.listByChannel, { channel: 'eng' })).toEqual([])
  })
})
