import { v } from 'convex/values'

import { authenticatedQuery } from '../utils/auth'
import { assertCallerSubscribedToChannel, requireTopic } from '../topics/helpers'

/**
 * Reactive per-topic feed. Subscribed to by the remote transport in
 * `mcp_server/src/transport/remote.ts` so that new messages push to Claude
 * Code via the Channel protocol without polling.
 *
 * The `sinceTs` argument is a client-side windowing hint: when set, the
 * query returns messages with `ts >= sinceTs` (inclusive). The inclusivity
 * matters because `ts` has millisecond resolution and two inserts in the
 * same mutation can share a timestamp — a strict `>` cursor would silently
 * drop the second message on reconnect. Clients must dedupe by `_id` on
 * their side to skip the watermark message on resubscribe; the transport
 * in `mcp_server/src/transport/remote.ts` does this explicitly.
 */
export const listByTopic = authenticatedQuery({
  args: {
    topicId: v.id('topics'),
    sinceTs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const topic = await requireTopic(ctx, args.topicId)
    await assertCallerSubscribedToChannel(ctx, topic.channelId)

    const cutoff = args.sinceTs
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_topic_and_ts', (q) => {
        const scoped = q.eq('topicId', topic._id)
        return cutoff === undefined ? scoped : scoped.gte('ts', cutoff)
      })
      .collect()
    return rows
  },
})

/**
 * Reactive per-channel feed: DMs AND broadcasts AND topic messages in this
 * channel, chronological. Exposed so the remote transport can subscribe to
 * a channel-wide feed (e.g. for the `list_channels` UI showing activity),
 * but most production reads happen through `listByTopic`.
 */
export const listByChannel = authenticatedQuery({
  args: {
    channelId: v.id('channels'),
    sinceTs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertCallerSubscribedToChannel(ctx, args.channelId)
    const cutoff = args.sinceTs
    return await ctx.db
      .query('messages')
      .withIndex('by_channel_and_ts', (q) => {
        const scoped = q.eq('channelId', args.channelId)
        return cutoff === undefined ? scoped : scoped.gte('ts', cutoff)
      })
      .collect()
  },
})

/**
 * Reactive DM inbox for one of the caller's own sessions. The caller MUST
 * own the sessionId - delivering another user's DMs would be an auth leak.
 */
export const listDirectMessagesForSession = authenticatedQuery({
  args: {
    sessionId: v.id('sessions'),
    sinceTs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId)
    if (session === null || session.userId !== ctx.userId) return []
    const cutoff = args.sinceTs
    return await ctx.db
      .query('messages')
      .withIndex('by_toSessionId_and_ts', (q) => {
        const scoped = q.eq('toSessionId', args.sessionId)
        return cutoff === undefined ? scoped : scoped.gte('ts', cutoff)
      })
      .collect()
  },
})
