import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `channelMembers` table.
 *
 * Records a user's standing subscription to a channel. Distinct from
 * `sessionChannels` (per-session presence) - a user is considered a member
 * of #engineering once they've joined it, regardless of which of their
 * concrete sessions is currently running.
 *
 * This separation is a deliberate extension over the broker's model. The
 * broker only knows about sessions; the Convex backend adds a user-level
 * membership so that across machines the subscribed-channels list survives
 * session restarts.
 *
 * Invariant: at most one row per (userId, channelId). Enforced at the
 * mutation layer via `by_user_and_channel` lookup-then-insert. Convex
 * mutations are serialised against conflicting document reads/writes and
 * will retry on conflict, so this is race-safe.
 */
export const channelMembersTable = defineTable({
  userId: v.id('users'),
  channelId: v.id('channels'),
  joinedAt: v.number(),
})
  .index('by_user', ['userId'])
  .index('by_channel', ['channelId'])
  .index('by_user_and_channel', ['userId', 'channelId'])
