/** MCP tool definitions — pure data, no Convex runtime dependencies. */

export const listTopicsTool = {
  name: 'list_topics',
  description: 'List active cccollab topics the authenticated user is a member of.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
}

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

export const ALL_TOOLS = [listTopicsTool, readTopicTool, sendMessageToTopicTool]
