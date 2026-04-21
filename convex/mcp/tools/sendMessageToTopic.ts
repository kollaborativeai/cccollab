import type { Id } from '../../_generated/dataModel.js'
import { api } from '../../_generated/api.js'
import type { McpCtx } from '../types.js'

export const sendMessageToTopicTool = {
  name: 'send_message_to_topic',
  description: 'Post a message to a cccollab topic you are a member of.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      topicId: { type: 'string' },
      text: { type: 'string', minLength: 1 },
    },
    required: ['topicId', 'text'],
    additionalProperties: false,
  },
}

export type SendMessageResult = { id: string } | { error: string }

export async function handleSendMessageToTopic(
  ctx: McpCtx,
  userId: Id<'users'>,
  args: { topicId: string; text: string },
): Promise<SendMessageResult> {
  if (!args.text || args.text.length === 0) {
    return { error: 'text is required' }
  }
  try {
    const id = await ctx.runMutation(api.messages.sendAsUser, {
      topicId: args.topicId as Id<'topics'>,
      userId,
      text: args.text,
    })
    return { id: id as string }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'error' }
  }
}
