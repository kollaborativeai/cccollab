import { v } from 'convex/values'
import { mutation, query } from './_generated/server.js'
import type { Doc, Id } from './_generated/dataModel.js'

export const getOrCreate = mutation({
  args: { name: v.string(), creatorUserId: v.id('users') },
  handler: async (ctx, { name, creatorUserId }): Promise<Id<'channels'>> => {
    const existing = await ctx.db
      .query('channels')
      .withIndex('by_name', (q) => q.eq('name', name))
      .unique()
    if (existing) return existing._id
    return await ctx.db.insert('channels', { name, createdBy: creatorUserId })
  },
})

export const join = mutation({
  args: { channelId: v.id('channels'), userId: v.id('users') },
  handler: async (ctx, { channelId, userId }): Promise<Id<'channelMemberships'>> => {
    const existing = await ctx.db
      .query('channelMemberships')
      .withIndex('by_user_channel', (q) => q.eq('userId', userId).eq('channelId', channelId))
      .unique()
    if (existing) return existing._id
    return await ctx.db.insert('channelMemberships', { channelId, userId })
  },
})

export const listForUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }): Promise<Doc<'channels'>[]> => {
    const memberships = await ctx.db
      .query('channelMemberships')
      .withIndex('by_user_channel', (q) => q.eq('userId', userId))
      .collect()
    const out: Doc<'channels'>[] = []
    for (const m of memberships) {
      const c = await ctx.db.get(m.channelId)
      if (c) out.push(c)
    }
    return out
  },
})
