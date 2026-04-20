import { defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * `channels` table.
 *
 * Channels are implicit namespaces for topics. In the local broker
 * (`mcp_server/src/broker.ts`) a channel is materialised the first time any
 * session joins it; the Convex backend mirrors that but adds a stable row so
 * channel ids can be used as foreign keys on topics/messages.
 *
 * - `name`: the original display name as the user typed it.
 * - `normalizedName`: trim + lowercase, identical to the broker's
 *   `normalizeChannel` output. All lookups go through this field so
 *   "engineering" and "Engineering" collapse to the same row.
 * - `createdAt`: epoch ms of the first join.
 *
 * The `by_normalizedName` index is the single source of truth for channel
 * identity - mutations that "join" a channel MUST go through it before
 * creating a new row, otherwise we'd store duplicates for the same logical
 * channel.
 */
export const channelsTable = defineTable({
  name: v.string(),
  normalizedName: v.string(),
  createdAt: v.number(),
}).index('by_normalizedName', ['normalizedName'])
