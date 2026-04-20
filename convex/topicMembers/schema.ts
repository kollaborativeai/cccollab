import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `topicMembers` table.
 *
 * Records which sessions have joined a topic, mirroring the broker's
 * `LocalTopic.joinedSessions` set. Only joined sessions receive
 * `notifications/claude/channel` pushes for messages in the topic (see
 * `broker-event-listener.ts`).
 *
 * Invariant: at most one row per (topicId, sessionId). Enforced at the
 * mutation layer through `by_topic_and_session` lookup-then-insert.
 */
export const topicMembersTable = defineTable({
  topicId: v.id('topics'),
  sessionId: v.id('sessions'),
  joinedAt: v.number(),
})
  .index('by_topic', ['topicId'])
  .index('by_session', ['sessionId'])
  .index('by_topic_and_session', ['topicId', 'sessionId'])
