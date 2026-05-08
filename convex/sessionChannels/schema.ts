import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `sessionChannels` table.
 *
 * Per-session channel presence. Distinct from `channelMembers` (user-level
 * standing subscription): a user may be subscribed to #engineering but only
 * some of their running sessions are currently tuned to that channel.
 * Matches the semantics of the broker's `SessionInfo.channels` set.
 *
 * Invariant: at most one row per (sessionId, channelId). Enforced at the
 * mutation layer through `by_session_and_channel` lookup-then-insert.
 *
 * When a session ends (process exits / deletes via `sessions.remove`), the
 * mutation that deletes the session row MUST also delete its
 * sessionChannels rows to keep the presence set honest.
 */
export const sessionChannelsTable = defineTable({
  sessionId: v.id('sessions'),
  channelId: v.id('channels'),
  joinedAt: v.number(),
})
  .index('by_session', ['sessionId'])
  .index('by_channel', ['channelId'])
  .index('by_session_and_channel', ['sessionId', 'channelId'])
