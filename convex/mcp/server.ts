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

/**
 * Per JSON-RPC 2.0 + MCP Streamable HTTP, a request with no `id` field is a
 * notification and MUST NOT receive a response. Callers should treat a
 * `null` return value as "write nothing back".
 */
/**
 * Assertion helper for tests: call `dispatchMcp` and throw if the response is
 * null (e.g., when the request is a notification). The HTTP endpoint uses the
 * raw `dispatchMcp` and translates null → 202 Accepted.
 */
export async function dispatchMcpExpectResponse(
  ctx: McpCtx,
  userId: Id<'users'>,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const res = await dispatchMcp(ctx, userId, request)
  if (res === null) throw new Error('dispatchMcp returned null; request was a notification')
  return res
}

export async function dispatchMcp(
  ctx: McpCtx,
  userId: Id<'users'>,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const isNotification = request.id === undefined || request.id === null
  const id = request.id ?? null
  // All `notifications/*` methods are one-way per the MCP spec — discard silently.
  if (request.method.startsWith('notifications/')) {
    return null
  }
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
      // Bare notification with unknown method: still silent.
      if (isNotification) return null
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${request.method}` } }
  }
}

async function handleToolCall(
  ctx: McpCtx,
  userId: Id<'users'>,
  id: JsonRpcRequest['id'],
  params: unknown,
): Promise<JsonRpcResponse> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'invalid params: expected object' } }
  }
  const p = params as { name?: unknown; arguments?: unknown }
  const name = typeof p.name === 'string' ? p.name : undefined
  const args = (p.arguments ?? {}) as Record<string, unknown>
  if (!name) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'invalid params: name required' } }
  }
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
