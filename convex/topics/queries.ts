import { v, ConvexError } from 'convex/values'

import type { Id } from '../_generated/dataModel'
import { authenticatedQuery, type AuthenticatedQueryCtx } from '../utils/auth'
import { normalizeChannelName } from '../channels/helpers'
import { assertCallerSubscribedToChannel } from './helpers'

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

/**
 * Single topic by id. Caller must be subscribed to the parent channel —
 * otherwise we'd leak topic existence and contents (name, channel,
 * creator) to any signed-in user who guesses an id. Topic ids are
 * server-issued and not user-secret, so the membership check is the
 * actual access control.
 *
 * Archived topics in channels the caller is still subscribed to remain
 * fetchable; this is the legitimate "look up my old archived topic" use
 * case. Leaving a channel removes the caller's topic memberships
 * (`channels.mutations.leave`), so a topic in a channel the caller has
 * abandoned is correctly inaccessible here.
 */
export const getById = authenticatedQuery({
  args: { topicId: v.id('topics') },
  handler: async (ctx, args) => {
    const topic = await ctx.db.get(args.topicId)
    if (topic === null) {
      throw new ConvexError({ code: 'TOPIC_NOT_FOUND', message: `No topic with id ${args.topicId}.` })
    }
    await assertCallerSubscribedToChannel(ctx, topic.channelId)
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
