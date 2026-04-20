import { v, ConvexError } from 'convex/values'

import type { Id } from '../_generated/dataModel'
import { authenticatedQuery, type AuthenticatedQueryCtx } from '../utils/auth'
import { normalizeChannelName } from '../channels/helpers'

/**
 * Topics inside a channel.
 *
 * Mirrors the broker's `GET /topics?channel=X&include_archived=...`:
 * - Caller must be subscribed to the channel (or the query returns empty).
 * - Archived topics are excluded unless `includeArchived: true`.
 */
export const listByChannel = authenticatedQuery({
  args: {
    channel: v.string(),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const normalized = normalizeChannelName(args.channel)
    if (normalized === null) return []

    const channel = await ctx.db
      .query('channels')
      .withIndex('by_normalizedName', (q) => q.eq('normalizedName', normalized))
      .unique()
    if (channel === null) return []

    const membership = await ctx.db
      .query('channelMembers')
      .withIndex('by_user_and_channel', (q) => q.eq('userId', ctx.userId).eq('channelId', channel._id))
      .unique()
    if (membership === null) return []

    const topics = await ctx.db
      .query('topics')
      .withIndex('by_channel', (q) => q.eq('channelId', channel._id))
      .collect()

    const filtered = args.includeArchived === true ? topics : topics.filter((t) => t.state === 'active')
    return filtered.map((t) => ({
      topicId: t._id,
      name: t.topic,
      normalizedName: t.normalizedTopic,
      state: t.state,
      channelId: t.channelId,
      creatorSessionId: t.creatorSessionId,
      createdAt: t.createdAt,
    }))
  },
})

/** Single topic by id. Unlike the list query this does NOT enforce channel
 *  subscription - callers may want to fetch an archived topic they left. */
export const getById = authenticatedQuery({
  args: { topicId: v.id('topics') },
  handler: async (ctx, args) => {
    const topic = await ctx.db.get(args.topicId)
    if (topic === null) {
      throw new ConvexError({ code: 'TOPIC_NOT_FOUND', message: `No topic with id ${args.topicId}.` })
    }
    return topic
  },
})

/**
 * Topic IDs the caller's signed-in sessions have joined, grouped
 * conceptually as "topics I'm currently in". Used by the remote transport
 * to bootstrap its subscription list when the MCP server starts up.
 */
export const listJoinedForUser = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_user', (q) => q.eq('userId', ctx.userId))
      .collect()
    const seen = new Set<Id<'topics'>>()
    const results: Array<Awaited<ReturnType<AuthenticatedQueryCtx['db']['get']>>> = []
    for (const session of sessions) {
      const memberships = await ctx.db
        .query('topicMembers')
        .withIndex('by_session', (q) => q.eq('sessionId', session._id))
        .collect()
      for (const m of memberships) {
        if (seen.has(m.topicId)) continue
        seen.add(m.topicId)
        const topic = await ctx.db.get(m.topicId)
        if (topic !== null) results.push(topic)
      }
    }
    return results
  },
})
