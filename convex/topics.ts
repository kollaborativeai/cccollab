import { v } from 'convex/values'
import { mutation, query } from './_generated/server.js'
import type { Doc, Id } from './_generated/dataModel.js'

export const create = mutation({
  args: {
    name: v.string(),
    channelId: v.id('channels'),
    creatorUserId: v.id('users'),
  },
  handler: async (ctx, { name, channelId, creatorUserId }): Promise<Id<'topics'>> => {
    const existing = await ctx.db
      .query('topics')
      .withIndex('by_name_channel', (q) => q.eq('name', name).eq('channelId', channelId))
      .unique()
    let topicId: Id<'topics'>
    if (existing && existing.state === 'active') {
      topicId = existing._id
    } else {
      topicId = await ctx.db.insert('topics', {
        name,
        channelId,
        state: 'active',
        createdBy: creatorUserId,
      })
    }
    const membership = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', creatorUserId).eq('topicId', topicId))
      .unique()
    if (!membership) {
      await ctx.db.insert('topicMemberships', { topicId, userId: creatorUserId })
    }
    return topicId
  },
})

export const join = mutation({
  args: { topicId: v.id('topics'), userId: v.id('users') },
  handler: async (ctx, { topicId, userId }): Promise<Id<'topicMemberships'>> => {
    const existing = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', userId).eq('topicId', topicId))
      .unique()
    if (existing) return existing._id
    return await ctx.db.insert('topicMemberships', { topicId, userId })
  },
})

export const listForUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }): Promise<Doc<'topics'>[]> => {
    const memberships = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', userId))
      .collect()
    const out: Doc<'topics'>[] = []
    for (const m of memberships) {
      const topic = await ctx.db.get(m.topicId)
      if (topic && topic.state === 'active') out.push(topic)
    }
    return out
  },
})

export const readForUser = query({
  args: { topicId: v.id('topics'), userId: v.id('users') },
  handler: async (ctx, { topicId, userId }): Promise<{ topic: Doc<'topics'>; messages: Doc<'messages'>[] } | null> => {
    const membership = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', userId).eq('topicId', topicId))
      .unique()
    if (!membership) return null
    const topic = await ctx.db.get(topicId)
    // Hide archived topics from readers even if their membership row remains.
    // `listForUser` already filters by state; `readForUser` must match.
    if (!topic || topic.state !== 'active') return null
    const messages = await ctx.db
      .query('messages')
      .withIndex('by_topic', (q) => q.eq('topicId', topicId))
      .order('desc')
      .take(READ_TOPIC_MESSAGE_CAP)
    // `.order('desc').take(N)` gives us the newest N; return them oldest-first
    // so the MCP client sees chronological history.
    return { topic, messages: messages.reverse() }
  },
})

/** Max messages returned by `read_topic` to keep MCP responses bounded. */
export const READ_TOPIC_MESSAGE_CAP = 200
