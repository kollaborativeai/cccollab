import { v, ConvexError } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { authenticatedMutation, type AuthenticatedMutationCtx } from '../utils/auth'
import { assertSessionOwnedByCaller } from '../sessions/mutations'
import { requireNormalizedChannelName } from './helpers'

/**
 * Join a channel.
 *
 * Both the user-level standing subscription (`channelMembers`) and the
 * session-level presence row (`sessionChannels`) are upserted. Idempotent -
 * calling join twice is a no-op beyond refreshing `joinedAt` on the session
 * presence row.
 *
 * Mirrors the broker's `POST /channels/join`.
 */
export const join = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    channel: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await assertSessionOwnedByCaller(ctx, args.sessionId)
    const normalized = requireNormalizedChannelName(args.channel)

    const channel = await findOrCreateChannel(ctx, args.channel, normalized)

    await ensureChannelMembership(ctx, channel._id)
    await ensureSessionPresence(ctx, session._id, channel._id)

    return {
      channelId: channel._id,
      name: channel.name,
      normalizedName: channel.normalizedName,
    }
  },
})

/**
 * Leave a channel.
 *
 * The broker's semantics: removes the session from the channel's members
 * AND removes them from any topics inside the channel (topicMembers rows).
 * We preserve that: a user leaving #engineering implicitly leaves every
 * topic they were in inside #engineering.
 *
 * Also removes the user-level `channelMembers` row - the standing
 * subscription is the thing we care about here, since the intent of
 * `leave_channel` is "I'm done with this channel across all my sessions".
 */
export const leave = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    channel: v.string(),
  },
  handler: async (ctx, args) => {
    await assertSessionOwnedByCaller(ctx, args.sessionId)
    const normalized = requireNormalizedChannelName(args.channel)

    const channel = await ctx.db
      .query('channels')
      .withIndex('by_normalizedName', (q) => q.eq('normalizedName', normalized))
      .unique()
    if (channel === null) {
      return { removed: false }
    }

    const membership = await ctx.db
      .query('channelMembers')
      .withIndex('by_user_and_channel', (q) => q.eq('userId', ctx.userId).eq('channelId', channel._id))
      .unique()
    if (membership !== null) {
      await ctx.db.delete(membership._id)
    }

    // Remove presence for every session of this user in this channel.
    await removeUserPresenceFromChannel(ctx, channel._id)

    // Remove topic membership for every topic in this channel owned by any
    // of this user's sessions. Mirrors the broker's loop over topics.
    await removeUserTopicMembershipsInChannel(ctx, channel._id)

    return { removed: membership !== null, channelId: channel._id }
  },
})

/** Idempotently upsert the `channels` row. */
async function findOrCreateChannel(
  ctx: AuthenticatedMutationCtx,
  displayName: string,
  normalizedName: string,
): Promise<Doc<'channels'>> {
  const existing = await ctx.db
    .query('channels')
    .withIndex('by_normalizedName', (q) => q.eq('normalizedName', normalizedName))
    .unique()
  if (existing !== null) return existing

  const id = await ctx.db.insert('channels', {
    name: displayName.trim(),
    normalizedName,
    createdAt: Date.now(),
  })
  const created = await ctx.db.get(id)
  if (created === null) {
    // `insert` then immediate `get` should always succeed; throw if Convex
    // ever violates that invariant so the caller sees a real error rather
    // than an opaque `undefined`.
    throw new ConvexError({ code: 'INTERNAL', message: 'Failed to re-read newly-created channel.' })
  }
  return created
}

async function ensureChannelMembership(ctx: AuthenticatedMutationCtx, channelId: Id<'channels'>): Promise<void> {
  const existing = await ctx.db
    .query('channelMembers')
    .withIndex('by_user_and_channel', (q) => q.eq('userId', ctx.userId).eq('channelId', channelId))
    .unique()
  if (existing !== null) return
  await ctx.db.insert('channelMembers', {
    userId: ctx.userId,
    channelId,
    joinedAt: Date.now(),
  })
}

async function ensureSessionPresence(
  ctx: AuthenticatedMutationCtx,
  sessionId: Id<'sessions'>,
  channelId: Id<'channels'>,
): Promise<void> {
  const existing = await ctx.db
    .query('sessionChannels')
    .withIndex('by_session_and_channel', (q) => q.eq('sessionId', sessionId).eq('channelId', channelId))
    .unique()
  if (existing !== null) return
  await ctx.db.insert('sessionChannels', {
    sessionId,
    channelId,
    joinedAt: Date.now(),
  })
}

async function removeUserPresenceFromChannel(ctx: AuthenticatedMutationCtx, channelId: Id<'channels'>): Promise<void> {
  const presence = await ctx.db
    .query('sessionChannels')
    .withIndex('by_channel', (q) => q.eq('channelId', channelId))
    .collect()
  for (const row of presence) {
    const session = await ctx.db.get(row.sessionId)
    if (session === null || session.userId !== ctx.userId) continue
    await ctx.db.delete(row._id)
  }
}

async function removeUserTopicMembershipsInChannel(
  ctx: AuthenticatedMutationCtx,
  channelId: Id<'channels'>,
): Promise<void> {
  const topicsInChannel = await ctx.db
    .query('topics')
    .withIndex('by_channel', (q) => q.eq('channelId', channelId))
    .collect()
  for (const topic of topicsInChannel) {
    const members = await ctx.db
      .query('topicMembers')
      .withIndex('by_topic', (q) => q.eq('topicId', topic._id))
      .collect()
    for (const member of members) {
      const session = await ctx.db.get(member.sessionId)
      if (session === null || session.userId !== ctx.userId) continue
      await ctx.db.delete(member._id)
    }
  }
}
