import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `topics` table.
 *
 * A topic is a threaded conversation inside a channel. The broker allows
 * at most one **active** topic per (channel, normalizedTopic) - archived
 * topics do not count against uniqueness, and unarchiving a topic whose
 * name collides with another active topic is rejected.
 *
 * Convex schemas don't support conditional uniqueness indexes, so the
 * constraint is enforced at the mutation layer (`topics.start` and
 * `topics.unarchive`). Convex mutations are serialised against conflicting
 * document reads/writes and retry on conflict, so lookup-then-insert is
 * race-safe.
 *
 * - `normalizedTopic`: trim + lowercase, mirroring the broker's
 *   `topic.trim().toLowerCase()` uniqueness check.
 * - `creatorSessionId`: the session that started the topic; `Id<'sessions'>`.
 * - `state`: active | archived. Messages may still be sent to archived
 *   topics by members who were joined at archive time (broker behaviour),
 *   so archiving is an "no new joins, no new uniqueness contention" flag,
 *   not a hard freeze.
 */
export const topicsTable = defineTable({
  channelId: v.id('channels'),
  topic: v.string(),
  normalizedTopic: v.string(),
  creatorSessionId: v.id('sessions'),
  state: v.union(v.literal('active'), v.literal('archived')),
  createdAt: v.number(),
})
  .index('by_channel', ['channelId'])
  .index('by_channel_and_normalizedTopic', ['channelId', 'normalizedTopic'])
