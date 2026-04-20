import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `messages` table.
 *
 * Mirrors the three broker event types that actually carry content:
 *
 * - `kind: "topic"` - a message inside a topic. `topicId` and `channelId`
 *   are both set. `channelId` is denormalised from the parent topic to
 *   keep the `by_channel_and_ts` index useful for a channel-wide feed
 *   (needed by the hosted transport's per-channel subscription). The
 *   mutation that inserts a topic message is responsible for keeping
 *   `channelId` consistent with `topicId`'s `channelId`; readers can and
 *   should assume the invariant holds.
 * - `kind: "broadcast"` - a top-level channel broadcast, `topicId` null.
 *   `channelId` set.
 * - `kind: "direct"` - a session-to-session DM. `toSessionId` is set.
 *   `channelId` is populated with the "shared channel used to route the
 *   DM" (see the broker's DM shared-channel rule), but readers should not
 *   treat this channel as part of the message's conversation context -
 *   DM delivery is gated on the sender and recipient sharing **some**
 *   channel at send time, not on the channel being "the DM's home".
 *
 * Indexes:
 * - `by_topic_and_ts` - per-topic chronological feed (the Phase 4
 *   reactive subscription).
 * - `by_channel_and_ts` - per-channel chronological feed for channel-wide
 *   views. Topic messages surface here via their denormalised `channelId`.
 * - `by_toSessionId_and_ts` - the recipient's DM inbox. The hosted
 *   transport subscribes to this index to push DMs reactively without
 *   scanning the whole messages table.
 *
 * `fromSessionId` is required (every message is sent by some session).
 * `fromUserId` is denormalised from the sender's session so lookup-based
 * filtering by user (e.g. "muted users") doesn't need a join. Writers
 * must keep `fromUserId` consistent with `fromSessionId`'s `userId`.
 */
export const messagesTable = defineTable({
  kind: v.union(v.literal('topic'), v.literal('broadcast'), v.literal('direct')),
  topicId: v.optional(v.id('topics')),
  channelId: v.optional(v.id('channels')),
  fromSessionId: v.id('sessions'),
  fromUserId: v.id('users'),
  toSessionId: v.optional(v.id('sessions')),
  text: v.string(),
  ts: v.number(),
})
  .index('by_topic_and_ts', ['topicId', 'ts'])
  .index('by_channel_and_ts', ['channelId', 'ts'])
  .index('by_toSessionId_and_ts', ['toSessionId', 'ts'])
