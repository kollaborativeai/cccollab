import type { Id } from '../_generated/dataModel.js'
import type { McpCtx } from './types.js'
import { listTopicsTool, handleListTopics } from './tools/listTopics.js'
import { readTopicTool, handleReadTopic } from './tools/readTopic.js'
import { sendMessageToTopicTool, handleSendMessageToTopic } from './tools/sendMessageToTopic.js'

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: unknown
}

export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

export const SERVER_INFO = { name: 'cccollab', version: '1.0.0' }
export const SERVER_CAPABILITIES = { tools: { listChanged: false } }
export const PROTOCOL_VERSION = '2025-06-18'

const ALL_TOOLS = [listTopicsTool, readTopicTool, sendMessageToTopicTool]

export async function dispatchMcp(
  ctx: McpCtx,
  userId: Id<'users'>,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const id = request.id ?? null
  switch (request.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: SERVER_CAPABILITIES,
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: ALL_TOOLS } }
    case 'tools/call':
      return await handleToolCall(ctx, userId, id, request.params)
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${request.method}` } }
  }
}

async function handleToolCall(
  ctx: McpCtx,
  userId: Id<'users'>,
  id: JsonRpcRequest['id'],
  params: unknown,
): Promise<JsonRpcResponse> {
  const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
  const name = p.name
  const args = p.arguments ?? {}
  let content: unknown
  switch (name) {
    case 'list_topics':
      content = await handleListTopics(ctx, userId)
      break
    case 'read_topic':
      content = await handleReadTopic(ctx, userId, args as { topicId: string })
      break
    case 'send_message_to_topic':
      content = await handleSendMessageToTopic(ctx, userId, args as { topicId: string; text: string })
      break
    default:
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `unknown tool: ${name}` } }
  }
  const isError = typeof content === 'object' && content !== null && 'error' in (content as Record<string, unknown>)
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify(content) }],
      isError,
    },
  }
}
