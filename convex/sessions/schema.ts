import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `sessions` table.
 *
 * A single running MCP server process. One user can have many concurrent
 * sessions (one per terminal, per machine). Session ids are `Id<'sessions'>`
 * and are the stable identifier used as foreign keys on topics, messages,
 * and topic members. The human-friendly `sessionName` ("architect",
 * "frontend", ...) is the one the user types into `introduce`; it is only
 * unique **within a single user** - Alice and Bob both calling their
 * session "architect" is legitimate.
 *
 * Indexes:
 * - `by_user` - list all of one user's sessions (used by `whoami`, logout).
 * - `by_user_and_sessionName` - enforce per-user uniqueness of sessionName
 *   at the mutation layer (lookup-then-insert).
 * - `by_sessionName` - NOT a uniqueness index. Used to resolve DM recipient
 *   names globally so the DM mutation can disambiguate
 *   ("architect" → { Alice's session, Bob's session }) and error
 *   usefully when there's more than one match.
 *
 * `machine` is a best-effort hostname/OS identifier supplied by the MCP
 * server. Useful for a future "which machine is this session on?" UX; not
 * structurally load-bearing.
 *
 * `lastSeenAt` is refreshed by `sessions.updateLastSeen` - the MCP server
 * pings it periodically so dashboards can show which sessions are live.
 */
export const sessionsTable = defineTable({
  userId: v.id('users'),
  sessionName: v.string(),
  objective: v.optional(v.string()),
  machine: v.optional(v.string()),
  createdAt: v.number(),
  lastSeenAt: v.number(),
})
  .index('by_user', ['userId'])
  .index('by_user_and_sessionName', ['userId', 'sessionName'])
  .index('by_sessionName', ['sessionName'])
