import type { Id } from '../../_generated/dataModel.js'
import { api } from '../../_generated/api.js'
import type { McpCtx } from '../types.js'

export const readTopicTool = {
  name: 'read_topic',
  description: 'Read a cccollab topic you are a member of, including its recent messages.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      topicId: { type: 'string', description: 'Topic id, as returned by list_topics.' },
    },
    required: ['topicId'],
    additionalProperties: false,
  },
}

export type ReadTopicResult =
  | { error: string }
  | {
      topic: { id: string; name: string; channelId: string }
      messages: Array<{
        id: string
        authorType: 'session' | 'external'
        authorName: string
        text: string
        createdAt: number
      }>
    }

export async function handleReadTopic(
  ctx: McpCtx,
  userId: Id<'users'>,
  args: { topicId: string },
): Promise<ReadTopicResult> {
  const result = await ctx.runQuery(api.topics.readForUser, {
    topicId: args.topicId as Id<'topics'>,
    userId,
  })
  if (!result) return { error: 'topic_not_found_or_not_a_member' }
  return {
    topic: {
      id: result.topic._id as string,
      name: result.topic.name,
      channelId: result.topic.channelId as string,
    },
    messages: result.messages.map((m) => ({
      id: m._id as string,
      authorType: m.authorType,
      authorName: m.authorName,
      text: m.text,
      createdAt: m._creationTime,
    })),
  }
}
