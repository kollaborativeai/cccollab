import { v } from 'convex/values'
import { internalQuery } from '../_generated/server.js'
import type { Doc } from '../_generated/dataModel.js'

export const getByClientId = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }): Promise<Doc<'oauthClients'> | null> => {
    return await ctx.db
      .query('oauthClients')
      .withIndex('by_clientId', (q) => q.eq('clientId', clientId))
      .unique()
  },
})
