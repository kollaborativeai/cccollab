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
 *   (needed by the remote transport's per-channel subscription). The
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
 * - `by_channel_and_ts` - per-channel chronological feed. Topic messages
 *   and DMs land on this index too (both store a `channelId` — topic for
 *   denormalisation, DM for shared-channel routing) but the
 *   `listByChannel` query filters to `kind === 'broadcast'` to keep
 *   topic content out of the channel feed and DMs out of bystanders'
 *   views. A future channel-wide activity view would need its own
 *   query rather than relaxing that filter.
 * - `by_toSessionId_and_ts` - the recipient's DM inbox. The remote
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

/**
 * `channelReadCursors` - per-(user, sessionName)-per-channel
 * high-water-mark for delivered broadcasts.
 *
 * Solves the duplicate-on-restart problem: the MCP server subscribes via
 * a Convex reactive `listByChannel` query; without a persisted cursor
 * every restart fires the full channel backlog into the notification
 * stream. This table stores the highest `ts` delivered to a given
 * logical session identity; subsequent subscribes filter strictly
 * greater than the stored cursor.
 *
 * Keying by `(userId, sessionName, channelId)` rather than
 * `(sessionId, channelId)` is deliberate. cccollab's `sessions`
 * rows are created on `introduce` and deleted on `remove` (shutdown);
 * every MCP restart gets a fresh `sessions._id` even when the user
 * keeps the same `sessionName`. The cursor must survive session row
 * churn, so it ties to the stable pair. Concurrent MCPs for the same
 * `(user, sessionName)` on different machines would share one cursor;
 * that's fine - they are by convention the same logical client.
 *
 * Deployment-level failure mode: if the deployment's `channelReadCursors`
 * table is wiped, clients see duplicates on their next subscribe. That
 * is the documented accepted tradeoff.
 */
export const channelReadCursorsTable = defineTable({
  userId: v.id('users'),
  sessionName: v.optional(v.string()),
  /** Legacy field from the initial keying by Convex session id. Kept
   *  optional so old rows validate during the migration; new writes
   *  don't populate it. A follow-up can drop it once the table has
   *  been naturally rotated. */
  sessionId: v.optional(v.id('sessions')),
  channelId: v.id('channels'),
  lastDeliveredTs: v.number(),
  updatedAt: v.number(),
})
  .index('by_user_and_sessionName_and_channel', ['userId', 'sessionName', 'channelId'])
  .index('by_user', ['userId'])
