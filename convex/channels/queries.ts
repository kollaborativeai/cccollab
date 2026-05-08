import { authenticatedQuery } from '../utils/auth'

/**
 * Return every channel the backend knows about together with subscriber and
 * presence counts. Mirrors the broker's `GET /channels` with no
 * `sessionId` argument - broker-global view.
 */
export const listAll = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const channels = await ctx.db.query('channels').collect()
    const results = []
    for (const channel of channels) {
      const members = await ctx.db
        .query('channelMembers')
        .withIndex('by_channel', (q) => q.eq('channelId', channel._id))
        .collect()
      const presence = await ctx.db
        .query('sessionChannels')
        .withIndex('by_channel', (q) => q.eq('channelId', channel._id))
        .collect()
      results.push({
        channelId: channel._id,
        name: channel.name,
        normalizedName: channel.normalizedName,
        subscriberCount: members.length,
        presentSessionCount: presence.length,
      })
    }
    return results
  },
})

/**
 * Channels the caller has subscribed to (user-level, across sessions).
 *
 * This is the remote equivalent of the caller's "my channels" list -
 * reactive, so a join on one session surfaces instantly in another.
 */
export const listForUser = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const memberships = await ctx.db
      .query('channelMembers')
      .withIndex('by_user', (q) => q.eq('userId', ctx.userId))
      .collect()
    const channels = []
    for (const m of memberships) {
      const channel = await ctx.db.get(m.channelId)
      if (channel === null) continue
      channels.push({
        channelId: channel._id,
        name: channel.name,
        normalizedName: channel.normalizedName,
        joinedAt: m.joinedAt,
      })
    }
    return channels
  },
})
