import type { Id } from '../../_generated/dataModel.js'
import { api } from '../../_generated/api.js'
import type { McpCtx } from '../types.js'

export const listTopicsTool = {
  name: 'list_topics',
  description: 'List active cccollab topics the authenticated user is a member of.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
}

export type ListTopicsResult = {
  topics: Array<{ id: string; name: string; channelId: string }>
}

export async function handleListTopics(
  ctx: McpCtx,
  userId: Id<'users'>,
): Promise<ListTopicsResult> {
  const rows = await ctx.runQuery(api.topics.listForUser, { userId })
  return {
    topics: rows.map((t) => ({
      id: t._id as string,
      name: t.name,
      channelId: t.channelId as string,
    })),
  }
}
