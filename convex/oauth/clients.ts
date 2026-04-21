import { v } from 'convex/values'

import type { Doc } from '../_generated/dataModel'
import { internalQuery } from '../_generated/server'

/** Look up an OAuth client by its `client_id`. Internal only — used by the
 *  token endpoint to verify confidential-client secrets. */
export const getByClientId = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }): Promise<Doc<'oauthClients'> | null> => {
    return await ctx.db
      .query('oauthClients')
      .withIndex('by_clientId', (q) => q.eq('clientId', clientId))
      .unique()
  },
})
