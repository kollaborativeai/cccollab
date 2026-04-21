import { v } from 'convex/values'
import { mutation, query } from './_generated/server.js'
import type { Doc, Id } from './_generated/dataModel.js'

export const send = mutation({
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
 * Membership-enforced send used by the HTTP MCP tools.
 * The caller supplies the *user id* (already resolved from the bearer token);
 * the function verifies membership and writes the message with attribution
 * fields lifted from the user record.
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

export const listRecent = query({
  args: {},
  handler: async (ctx): Promise<Doc<'messages'>[]> => {
    const rows = await ctx.db.query('messages').order('desc').take(50)
    return rows.reverse()
  },
})
