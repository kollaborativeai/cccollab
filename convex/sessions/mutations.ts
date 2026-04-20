import { v, ConvexError } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { authenticatedMutation, type AuthenticatedMutationCtx } from '../utils/auth'

/**
 * Upsert the caller's session row.
 *
 * Mirrors the broker's `POST /sessions` plus its behaviour in
 * `introduce` - a repeat call with the same (userId, sessionName) refreshes
 * `objective`, `machine`, and `lastSeenAt` instead of creating a duplicate.
 * A different user calling `introduce({ name: "architect" })` gets their own
 * row because the uniqueness index is `by_user_and_sessionName`.
 */
export const introduce = authenticatedMutation({
  args: {
    sessionName: v.string(),
    objective: v.optional(v.string()),
    machine: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.sessionName.trim()
    if (name.length === 0) {
      throw new ConvexError({
        code: 'INVALID_SESSION_NAME',
        message: 'Session name must be a non-empty string.',
      })
    }

    const now = Date.now()
    const existing = await findOwnSession(ctx, name)
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        objective: args.objective,
        machine: args.machine,
        lastSeenAt: now,
      })
      return existing._id
    }

    const sessionId: Id<'sessions'> = await ctx.db.insert('sessions', {
      userId: ctx.userId,
      sessionName: name,
      objective: args.objective,
      machine: args.machine,
      createdAt: now,
      lastSeenAt: now,
    })
    return sessionId
  },
})

/**
 * Bump the caller's `lastSeenAt`. The MCP server calls this on a timer so
 * presence UIs can tell which sessions are alive.
 */
export const updateLastSeen = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
  },
  handler: async (ctx, args) => {
    await assertSessionOwnedByCaller(ctx, args.sessionId)
    await ctx.db.patch(args.sessionId, { lastSeenAt: Date.now() })
  },
})

/**
 * Delete the caller's session row plus the sessionChannels + topicMembers
 * rows that reference it. The broker does this implicitly on SIGTERM.
 */
export const remove = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
  },
  handler: async (ctx, args) => {
    await assertSessionOwnedByCaller(ctx, args.sessionId)

    const sessionChannels = await ctx.db
      .query('sessionChannels')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect()
    for (const row of sessionChannels) {
      await ctx.db.delete(row._id)
    }

    const topicMemberships = await ctx.db
      .query('topicMembers')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect()
    for (const row of topicMemberships) {
      await ctx.db.delete(row._id)
    }

    await ctx.db.delete(args.sessionId)
  },
})

/**
 * Look up one of the caller's own sessions by name.
 *
 * Deliberately scoped to `ctx.userId`: other users may have sessions with the
 * same name, and we must never return rows that do not belong to the caller.
 */
async function findOwnSession(ctx: AuthenticatedMutationCtx, sessionName: string): Promise<Doc<'sessions'> | null> {
  return await ctx.db
    .query('sessions')
    .withIndex('by_user_and_sessionName', (q) => q.eq('userId', ctx.userId).eq('sessionName', sessionName))
    .unique()
}

/**
 * Assert that the given session row belongs to the caller. Used by every
 * mutation that writes through a `sessionId` the caller supplied.
 */
export async function assertSessionOwnedByCaller(
  ctx: AuthenticatedMutationCtx,
  sessionId: Id<'sessions'>,
): Promise<Doc<'sessions'>> {
  const session = await ctx.db.get(sessionId)
  if (session === null) {
    throw new ConvexError({
      code: 'SESSION_NOT_FOUND',
      message: `No session with id ${sessionId}.`,
    })
  }
  if (session.userId !== ctx.userId) {
    throw new ConvexError({
      code: 'NOT_OWNER',
      message: `Session ${sessionId} does not belong to the caller.`,
    })
  }
  return session
}
