import { v } from 'convex/values'
import { mutation, query } from './_generated/server.js'
import type { Doc, Id } from './_generated/dataModel.js'

export const getByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }): Promise<Doc<'users'> | null> => {
    return await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique()
  },
})

export const getById = query({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }): Promise<Doc<'users'> | null> => {
    return await ctx.db.get(userId)
  },
})

export const getOrCreateByClerk = mutation({
  args: {
    clerkId: v.string(),
    email: v.optional(v.string()),
    displayName: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'users'>> => {
    const existing = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', args.clerkId))
      .unique()
    if (existing) {
      if (existing.displayName !== args.displayName || existing.email !== args.email) {
        await ctx.db.patch(existing._id, {
          displayName: args.displayName,
          email: args.email,
        })
      }
      return existing._id
    }
    return await ctx.db.insert('users', {
      clerkId: args.clerkId,
      email: args.email,
      displayName: args.displayName,
    })
  },
})
