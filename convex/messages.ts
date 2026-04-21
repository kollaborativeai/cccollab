import { v } from 'convex/values'
import { internalMutation, mutation, query } from './_generated/server.js'
import type { Doc, Id } from './_generated/dataModel.js'

/**
 * Raw message insert, bypassing membership checks. Only callable from other
 * trusted server functions and tests (via `convexTest`'s internal path). The
 * HTTP MCP surface uses `sendAsUser` below, which enforces membership and
 * derives attribution from the authenticated user record.
 */
export const send = internalMutation({
  args: {
    topicId: v.id('topics'),
    authorType: v.union(v.literal('session'), v.literal('external')),
    authorKey: v.string(),
    authorName: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'messages'>> => {
    return await ctx.db.insert('messages', args)
  },
})

/**
 * Membership-enforced send used by the HTTP MCP tools. The caller supplies the
 * *user id* (already resolved from the bearer token); the function verifies
 * membership and writes the message with attribution fields lifted from the
 * user record.
 */
export const sendAsUser = mutation({
  args: {
    topicId: v.id('topics'),
    userId: v.id('users'),
    text: v.string(),
  },
  handler: async (ctx, { topicId, userId, text }): Promise<Id<'messages'>> => {
    const membership = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', userId).eq('topicId', topicId))
      .unique()
    if (!membership) throw new Error('User is not a member of this topic')
    const user = await ctx.db.get(userId)
    if (!user) throw new Error('User not found')
    return await ctx.db.insert('messages', {
      topicId,
      authorType: 'external',
      authorKey: user.clerkId,
      authorName: user.displayName,
      text,
    })
  },
})

export const listForTopic = query({
  args: { topicId: v.id('topics') },
  handler: async (ctx, { topicId }): Promise<Doc<'messages'>[]> => {
    return await ctx.db
      .query('messages')
      .withIndex('by_topic', (q) => q.eq('topicId', topicId))
      .collect()
  },
})

/**
 * Hydrated message row used by the Convex-to-broker bridge. Includes the
 * topic's human-readable name and parent channel name so the bridge can
 * build a broker `/local-event` payload the plugin's SSE listener can route.
 */
export type HydratedMessage = Doc<'messages'> & {
  topicName: string
  channelName: string
}

export const listRecent = query({
  args: {},
  handler: async (ctx): Promise<HydratedMessage[]> => {
    const rows = await ctx.db.query('messages').order('desc').take(50)
    const topicCache = new Map<Id<'topics'>, { name: string; channelName: string }>()
    const channelCache = new Map<Id<'channels'>, string>()
    const out: HydratedMessage[] = []
    for (const row of rows) {
      let info = topicCache.get(row.topicId)
      if (!info) {
        const topic = await ctx.db.get(row.topicId)
        if (!topic) continue
        let channelName = channelCache.get(topic.channelId)
        if (!channelName) {
          const channel = await ctx.db.get(topic.channelId)
          if (!channel) continue
          channelName = channel.name
          channelCache.set(topic.channelId, channelName)
        }
        info = { name: topic.name, channelName }
        topicCache.set(row.topicId, info)
      }
      out.push({ ...row, topicName: info.name, channelName: info.channelName })
    }
    return out.reverse()
  },
})
