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

    // Archived topics stop delivering messages. Members keep their
    // topicMembers row and can unarchive later, but reactive
    // subscriptions on an archived topic return empty — matches the
    // broker's "archive means 'no new activity on this thread'" semantic.
    if (topic.state === 'archived') return []

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
 * Reactive per-channel broadcast feed, chronological.
 *
 * Returns ONLY `kind === 'broadcast'` rows even though the underlying
 * `by_channel_and_ts` index also covers topic messages and DMs (both
 * carry a `channelId` for indexing / routing). The MCP server's
 * `RemoteTransport.subscribeChannelMessages` treats every row from this
 * query as a top-level broadcast (`threadTs: undefined`), so surfacing
 * non-broadcast kinds here would:
 *   - duplicate every topic message for peers subscribed to both the
 *     channel and the topic (once via topic sub, once as a fake broadcast)
 *   - leak topic-only content to channel subscribers who haven't joined
 *     the topic
 *   - leak DMs that route through the channel to every channel subscriber
 *
 * A future "channel-wide activity" view that legitimately wants all
 * kinds should be a separate query rather than re-opening this one.
 */
export const listByChannel = authenticatedQuery({
  args: {
    channelId: v.id('channels'),
    sinceTs: v.optional(v.number()),
    /** When supplied, `listByChannel` consults the caller's
     *  `channelReadCursors` row for this session and drops messages with
     *  `ts <= lastDeliveredTs`. An explicit `sinceTs` overrides the
     *  cursor. The MCP server's `RemoteTransport.subscribeChannelMessages`
     *  passes its sessionId here so restart-replay is suppressed. */
    sessionId: v.optional(v.id('sessions')),
  },
  handler: async (ctx, args) => {
    await assertCallerSubscribedToChannel(ctx, args.channelId)
    let cutoff = args.sinceTs
    // Per-session cursor filtering uses strict `>` so an acked `ts`
    // isn't re-delivered. Only consulted when no explicit `sinceTs`.
    // Session ownership is verified so a caller can't use another
    // user's cursor to probe the channel.
    let useExclusive = false
    if (cutoff === undefined && args.sessionId !== undefined) {
      const session = await ctx.db.get(args.sessionId)
      if (session !== null && session.userId === ctx.userId) {
        const cursor = await ctx.db
          .query('channelReadCursors')
          .withIndex('by_user_and_sessionName_and_channel', (q) =>
            q.eq('userId', ctx.userId).eq('sessionName', session.sessionName).eq('channelId', args.channelId),
          )
          .unique()
        if (cursor !== null) {
          cutoff = cursor.lastDeliveredTs
          useExclusive = true
        }
      }
    }
    return await ctx.db
      .query('messages')
      .withIndex('by_channel_and_ts', (q) => {
        const scoped = q.eq('channelId', args.channelId)
        if (cutoff === undefined) return scoped
        return useExclusive ? scoped.gt('ts', cutoff) : scoped.gte('ts', cutoff)
      })
      // The index narrows to one channel within the cursor window; the
      // post-filter only removes topic/DM rows from that already-small
      // set, so it isn't the "filter instead of index" anti-pattern the
      // rule guards against. A compound `(channelId, kind, ts)` index
      // would be tidier but isn't worth the schema migration today.
      // eslint-disable-next-line @convex-dev/no-filter-in-query
      .filter((q) => q.eq(q.field('kind'), 'broadcast'))
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
