import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `oauthGrants` table.
 *
 * One row per `(userId, clientId)` pair. Exists purely as an OCC sentinel
 * document for the token-exchange + refresh-rotate flows.
 *
 * Why: Convex OCC tracks *index intervals*, not just matched document
 * IDs (see `crates/database/src/reads.rs` — `ReadSet.indexed` is an
 * `IntervalSet` and `overlaps_document` checks whether a written key
 * falls in any tracked interval). Reading an `oauthAccessTokens` index
 * range for `(userId, clientId)` records the interval in the read set
 * even when it's empty — but the conflict detection there only fires
 * if a concurrent exchange writes an access-token row, which on a
 * first-time authorize both flows would do independently. The first
 * writer would commit, the second would conflict, retry, and observe
 * the first's tokens. Without the sentinel the same argument holds,
 * but it forces reviewers to trace the OCC story through the token
 * tables for every code path that issues tokens.
 *
 * The sentinel collapses that reasoning into a single shared document
 * per `(userId, clientId)`: every code-exchange and refresh-rotation
 * reads + patches this row, so OCC always fires on a well-known,
 * explicitly-named anchor. The later mutation is retried; on retry it
 * sees the earlier flow's tokens in the revoke step and marks them
 * revoked.
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
