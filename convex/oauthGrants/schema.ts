import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `oauthGrants` table.
 *
 * One row per `(userId, clientId)` pair. Exists purely as an OCC sentinel
 * document for the token-exchange + refresh-rotate flows.
 *
 * Why: Convex's optimistic-concurrency-control conflict detection is
 * **document-keyed**, not range-keyed. Reading an index range adds no
 * document IDs to the read set if the range returns zero rows, so two
 * concurrent mutations that both read an empty `oauthAccessTokens`
 * index for the same `(userId, clientId)` pair and then both insert
 * new rows would both commit — producing two overlapping valid token
 * pairs.
 *
 * The fix: every code-exchange and refresh-rotation reads the grant
 * row by `(userId, clientId)` and patches its `version` counter.
 * Because both concurrent mutations read and write the same document,
 * OCC genuinely fires and the later one is retried. On retry it sees
 * the earlier flow's tokens and revokes them as part of its own revoke
 * step.
 *
 * Fields:
 * - `userId` / `clientId`: foreign keys identifying the grant.
 * - `version`: monotonically incremented on every token-issuing mutation.
 *   The actual value is meaningless; the write is load-bearing.
 * - `lastRotatedAt`: epoch ms of the last successful token issuance,
 *   useful for admin / debugging.
 */
export const oauthGrantsTable = defineTable({
  userId: v.id('users'),
  clientId: v.string(),
  version: v.number(),
  lastRotatedAt: v.number(),
}).index('by_userId_and_clientId', ['userId', 'clientId'])
