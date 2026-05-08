import { v } from 'convex/values'

import type { Id } from '../_generated/dataModel'
import { authenticatedQuery } from '../utils/auth'
import { normalizeChannelName } from '../channels/helpers'

/**
 * Return the caller's current signed-in user document. `null` would mean
 * unauthenticated, but `authenticatedQuery` already rejects that case - so
 * this always returns a populated doc to the caller. Useful as an "am I
 * signed in and who as?" probe from the MCP server at startup.
 */
export const whoami = authenticatedQuery({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db.get(ctx.userId)
    if (user === null) return null
    return {
      userId: user._id,
      email: user.email,
      name: user.name,
      image: user.image,
    }
  },
})

/**
 * List sessions the caller can see.
 *
 * Scope rules mirror the broker: when `channel` is provided we scope to that
 * channel's members (the caller must be subscribed). With no channel argument
 * we return sessions in any of the caller's subscribed channels so
 * `list_sessions` surfaces useful collaborators.
 *
 * Sessions are joined through the `sessionChannels` presence table, not the
 * user-level `channelMembers` subscription table, because the point of this
 * query is "who is currently tuned in", not "who has ever subscribed".
 */
export const listByChannel = authenticatedQuery({
  args: {
    channel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const normalized = args.channel !== undefined ? normalizeChannelName(args.channel) : undefined

    // Resolve target channels.
    let channelIds: Id<'channels'>[]
    if (normalized !== undefined && normalized !== null) {
      const channel = await ctx.db
        .query('channels')
        .withIndex('by_normalizedName', (q) => q.eq('normalizedName', normalized))
        .unique()
      if (channel === null) return []

      // Caller must be subscribed to the requested channel.
      const membership = await ctx.db
        .query('channelMembers')
        .withIndex('by_user_and_channel', (q) => q.eq('userId', ctx.userId).eq('channelId', channel._id))
        .unique()
      if (membership === null) return []
      channelIds = [channel._id]
    } else {
      const memberships = await ctx.db
        .query('channelMembers')
        .withIndex('by_user', (q) => q.eq('userId', ctx.userId))
        .collect()
      channelIds = memberships.map((m) => m.channelId)
      if (channelIds.length === 0) return []
    }

    // Collect every session id that has a presence row in any of those
    // channels. Preserve insertion order but dedupe - a session subscribed
    // to multiple shared channels should surface once.
    const seen = new Set<Id<'sessions'>>()
    const sessionIdsOrdered: Id<'sessions'>[] = []
    for (const channelId of channelIds) {
      const presence = await ctx.db
        .query('sessionChannels')
        .withIndex('by_channel', (q) => q.eq('channelId', channelId))
        .collect()
      for (const p of presence) {
        if (seen.has(p.sessionId)) continue
        seen.add(p.sessionId)
        sessionIdsOrdered.push(p.sessionId)
      }
    }

    // Fetch session docs. Null rows shouldn't happen but the code tolerates
    // a race where a sessionChannels row points at a deleted session.
    //
    // Projection: deliberately drop `userId` from the wire response.
    // `userId` is a stable internal identifier; surfacing it lets any
    // authenticated user in a shared channel enumerate the user-id of
    // every other session in that channel. The fields we keep are the
    // ones the MCP server's `listSessions` tool actually needs.
    const sessions: Array<{
      _id: Id<'sessions'>
      sessionName: string
      objective?: string
      machine?: string
      createdAt: number
      lastSeenAt: number
    }> = []
    for (const id of sessionIdsOrdered) {
      const session = await ctx.db.get(id)
      if (session === null) continue
      sessions.push({
        _id: session._id,
        sessionName: session.sessionName,
        objective: session.objective,
        machine: session.machine,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      })
    }
    return sessions
  },
})
