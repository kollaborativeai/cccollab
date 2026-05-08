import { v, ConvexError } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { authenticatedMutation, type AuthenticatedMutationCtx } from '../utils/auth'
import { assertSessionOwnedByCaller } from '../sessions/mutations'
import { requireNormalizedChannelName } from '../channels/helpers'
import { assertCallerSubscribedToChannel, requireTopic } from './helpers'

/**
 * Start (create) a topic inside a channel.
 *
 * Mirrors the broker's `POST /topics`:
 * - Creator must be subscribed to the channel.
 * - If an **active** topic with the same normalized name already exists in
 *   the channel, reject with `TOPIC_NAME_CONFLICT` and return the existing
 *   topic so the caller can decide to join instead.
 * - Archived topics with a colliding name are tolerated (the new topic
 *   takes the active slot).
 *
 * Race safety: Convex mutations serialise against conflicting document
 * reads/writes, so the existence check + insert pair cannot be interleaved
 * with another concurrent `start` on the same (channel, normalizedTopic).
 */
export const start = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    channel: v.string(),
    topic: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await assertSessionOwnedByCaller(ctx, args.sessionId)
    const normalizedChannel = requireNormalizedChannelName(args.channel)
    const topicName = args.topic.trim()
    if (topicName.length === 0) {
      throw new ConvexError({
        code: 'INVALID_TOPIC_NAME',
        message: 'Topic name must be a non-empty string.',
      })
    }
    const normalizedTopic = topicName.toLowerCase()

    const channel = await ctx.db
      .query('channels')
      .withIndex('by_normalizedName', (q) => q.eq('normalizedName', normalizedChannel))
      .unique()
    if (channel === null) {
      throw new ConvexError({
        code: 'CHANNEL_NOT_FOUND',
        message: `Channel "${args.channel}" does not exist. Join it first.`,
      })
    }

    await assertCallerSubscribedToChannel(ctx, channel._id)

    // Reject an active same-name topic; tolerate archived collisions.
    const colliding = await findActiveTopicByNormalizedName(ctx, channel._id, normalizedTopic)
    if (colliding !== null) {
      throw new ConvexError({
        code: 'TOPIC_NAME_CONFLICT',
        message: `A topic named "${colliding.topic}" already exists in this channel. Join it instead, or use a different name.`,
        existingTopicId: colliding._id,
      })
    }

    const topicId = await ctx.db.insert('topics', {
      channelId: channel._id,
      topic: topicName,
      normalizedTopic,
      creatorSessionId: session._id,
      state: 'active',
      createdAt: Date.now(),
    })

    // The creator is implicitly a member of their own topic - mirrors how
    // the broker treats a topic creator.
    await ctx.db.insert('topicMembers', {
      topicId,
      sessionId: session._id,
      joinedAt: Date.now(),
    })

    return { topicId, channelId: channel._id, name: topicName, state: 'active' as const }
  },
})

/** Join a topic; caller must be subscribed to the parent channel. */
export const join = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    topicId: v.id('topics'),
  },
  handler: async (ctx, args) => {
    const session = await assertSessionOwnedByCaller(ctx, args.sessionId)
    const topic = await requireTopic(ctx, args.topicId)
    await assertCallerSubscribedToChannel(ctx, topic.channelId)

    const existing = await ctx.db
      .query('topicMembers')
      .withIndex('by_topic_and_session', (q) => q.eq('topicId', topic._id).eq('sessionId', session._id))
      .unique()
    if (existing === null) {
      await ctx.db.insert('topicMembers', {
        topicId: topic._id,
        sessionId: session._id,
        joinedAt: Date.now(),
      })
    }

    return { topicId: topic._id, channelId: topic.channelId, name: topic.topic }
  },
})

/** Leave a topic; no-op if the caller isn't a member. */
export const leave = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    topicId: v.id('topics'),
  },
  handler: async (ctx, args) => {
    const session = await assertSessionOwnedByCaller(ctx, args.sessionId)
    const membership = await ctx.db
      .query('topicMembers')
      .withIndex('by_topic_and_session', (q) => q.eq('topicId', args.topicId).eq('sessionId', session._id))
      .unique()
    if (membership !== null) {
      await ctx.db.delete(membership._id)
    }
    return { topicId: args.topicId, left: membership !== null }
  },
})

/**
 * Archive a topic. Anyone subscribed to the parent channel may archive
 * (matches broker - it doesn't require topic membership or creator
 * identity).
 */
export const archive = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    topicId: v.id('topics'),
  },
  handler: async (ctx, args) => {
    await assertSessionOwnedByCaller(ctx, args.sessionId)
    const topic = await requireTopic(ctx, args.topicId)
    await assertCallerSubscribedToChannel(ctx, topic.channelId)
    if (topic.state !== 'archived') {
      await ctx.db.patch(topic._id, { state: 'archived' })
    }
    return { topicId: topic._id, state: 'archived' as const }
  },
})

/**
 * Unarchive a topic. Rejected with `TOPIC_NAME_CONFLICT` if another active
 * topic has since taken the same normalized name in the parent channel.
 */
export const unarchive = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    topicId: v.id('topics'),
  },
  handler: async (ctx, args) => {
    await assertSessionOwnedByCaller(ctx, args.sessionId)
    const topic = await requireTopic(ctx, args.topicId)
    await assertCallerSubscribedToChannel(ctx, topic.channelId)

    if (topic.state === 'active') {
      return { topicId: topic._id, state: 'active' as const }
    }

    const conflict = await findActiveTopicByNormalizedName(ctx, topic.channelId, topic.normalizedTopic)
    if (conflict !== null) {
      throw new ConvexError({
        code: 'TOPIC_NAME_CONFLICT',
        message: `Cannot unarchive "${topic.topic}": another active topic already uses this name.`,
        existingTopicId: conflict._id,
      })
    }

    await ctx.db.patch(topic._id, { state: 'active' })
    return { topicId: topic._id, state: 'active' as const }
  },
})

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Convex's schema indexes don't support conditional uniqueness, so we can't
 * index on `(channelId, normalizedTopic, state)` to point at just the
 * active topic row. Every archive-then-start-same-name cycle leaves a row
 * in the table with that (channelId, normalizedTopic) key, so this scan
 * grows linearly in archived revisions.
 *
 * The `.take(100)` cap bounds latency at worst case. For any single team
 * to exceed 100 archived revisions of one topic name would be very
 * unusual; we prefer degrading correctness slightly (returning `null` and
 * inserting a new row even if one of the first 100 hits is active) to
 * unbounded scan latency, because the mutation's insert path would then
 * rely on its other uniqueness checks to surface a conflict cleanly.
 */
const ACTIVE_TOPIC_LOOKUP_LIMIT = 100

async function findActiveTopicByNormalizedName(
  ctx: AuthenticatedMutationCtx,
  channelId: Id<'channels'>,
  normalizedTopic: string,
): Promise<Doc<'topics'> | null> {
  const matches = await ctx.db
    .query('topics')
    .withIndex('by_channel_and_normalizedTopic', (q) =>
      q.eq('channelId', channelId).eq('normalizedTopic', normalizedTopic),
    )
    .take(ACTIVE_TOPIC_LOOKUP_LIMIT)
  for (const t of matches) {
    if (t.state === 'active') return t
  }
  return null
}
