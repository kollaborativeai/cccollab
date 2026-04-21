import { ConvexError } from 'convex/values'
import type { GenericActionCtx } from 'convex/server'

import { internal } from '../_generated/api'
import type { DataModel, Doc, Id } from '../_generated/dataModel'
import { ALL_TOOLS } from './tools'

/**
 * MCP streamable-HTTP JSON-RPC dispatcher.
 *
 * Stateless: every incoming request arrives on `/mcp` carrying the user's
 * identity in the `Authorization: Bearer <token>` header; the HTTP handler
 * resolves that to (userId, sessionId) and then calls `dispatchMcp`. Each
 * dispatch returns one JSON-RPC response — or `null` for notifications,
 * which the HTTP handler translates to a 202 Accepted.
 */

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

/**
 * Versions we know how to speak, newest first. MCP `initialize` expects the
 * server to echo a version the client can handle — if the client's
 * requested version is in this list, we echo it verbatim; otherwise we
 * echo our newest and let the client decide whether to proceed.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

function negotiateProtocolVersion(params: unknown): string {
  if (typeof params !== 'object' || params === null) return PROTOCOL_VERSION
  const requested = (params as { protocolVersion?: unknown }).protocolVersion
  if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested
  }
  // Unknown version: respond with our newest. Clients that enforce strict
  // version matching will reject; clients that best-effort-accept will
  // continue. Either outcome is preferable to guessing.
  return PROTOCOL_VERSION
}

export type McpIdentity = {
  userId: Id<'users'>
  sessionId: Id<'sessions'>
}

/**
 * Per JSON-RPC 2.0 + MCP spec, a request with no `id` is a notification
 * and MUST NOT receive a response. Returns `null` in that case so the
 * HTTP layer can emit an empty 202.
 */
export async function dispatchMcp(
  ctx: GenericActionCtx<DataModel>,
  identity: McpIdentity,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const isNotification = request.id === undefined || request.id === null
  const id = request.id ?? null

  if (request.method.startsWith('notifications/')) return null

  switch (request.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(request.params),
          serverInfo: SERVER_INFO,
          capabilities: SERVER_CAPABILITIES,
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: ALL_TOOLS } }
    case 'tools/call':
      return await handleToolCall(ctx, identity, id, request.params)
    default:
      if (isNotification) return null
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${request.method}` },
      }
  }
}

async function handleToolCall(
  ctx: GenericActionCtx<DataModel>,
  identity: McpIdentity,
  id: JsonRpcRequest['id'],
  params: unknown,
): Promise<JsonRpcResponse> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32602, message: 'invalid params: expected object' },
    }
  }
  const p = params as { name?: unknown; arguments?: unknown }
  const name = typeof p.name === 'string' ? p.name : undefined
  const args = (p.arguments ?? {}) as Record<string, unknown>
  if (!name) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32602, message: 'invalid params: name required' },
    }
  }

  let content: unknown
  try {
    switch (name) {
      case 'list_topics':
        content = await handleListTopics(ctx, identity)
        break
      case 'read_topic':
        content = await handleReadTopic(ctx, identity, args as { topicId?: unknown })
        break
      case 'send_message_to_topic':
        content = await handleSendMessageToTopic(ctx, identity, args as { topicId?: unknown; text?: unknown })
        break
      default:
        return {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32601, message: `unknown tool: ${name}` },
        }
    }
  } catch (err) {
    // Convex errors carry a structured `data.code`; surface it as a JSON-RPC
    // tool error (isError: true) rather than a protocol-level -32603 so MCP
    // clients see a readable message instead of a generic internal error.
    const message =
      err instanceof ConvexError
        ? readableMessage(err as ConvexError<{ code?: string; message?: string }>)
        : err instanceof Error
          ? err.message
          : 'error'
    content = { error: message }
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

function readableMessage(err: ConvexError<{ code?: string; message?: string } | string>): string {
  const data = err.data
  if (typeof data === 'object' && data !== null) {
    const code = typeof data.code === 'string' ? data.code : undefined
    const message = typeof data.message === 'string' ? data.message : undefined
    if (code && message) return `${code}: ${message}`
    if (message) return message
    if (code) return code
  }
  return err.message
}

async function handleListTopics(
  ctx: GenericActionCtx<DataModel>,
  identity: McpIdentity,
): Promise<{ topics: Array<{ id: string; name: string; channelId: string }> }> {
  const rows = await ctx.runQuery(internal.mcp.ops.listTopicsForUser, { userId: identity.userId })
  return {
    topics: rows.map((t: Doc<'topics'>) => ({
      id: t._id as string,
      name: t.topic,
      channelId: t.channelId as string,
    })),
  }
}

async function handleReadTopic(
  ctx: GenericActionCtx<DataModel>,
  identity: McpIdentity,
  args: { topicId?: unknown },
): Promise<
  | { error: string }
  | {
      topic: { id: string; name: string; channelId: string; state: string }
      messages: Array<{ id: string; kind: string; authorSessionId: string; text: string; ts: number }>
    }
> {
  if (typeof args.topicId !== 'string' || args.topicId.length === 0) {
    return { error: 'topicId is required' }
  }
  const result = await ctx.runQuery(internal.mcp.ops.readTopicForUser, {
    userId: identity.userId,
    topicId: args.topicId as Id<'topics'>,
  })
  if (!result) return { error: 'topic_not_found_or_not_a_member' }
  return {
    topic: {
      id: result.topic._id as string,
      name: result.topic.topic,
      channelId: result.topic.channelId as string,
      state: result.topic.state,
    },
    messages: result.messages.map((m: Doc<'messages'>) => ({
      id: m._id as string,
      kind: m.kind,
      authorSessionId: m.fromSessionId as string,
      text: m.text,
      ts: m.ts,
    })),
  }
}

async function handleSendMessageToTopic(
  ctx: GenericActionCtx<DataModel>,
  identity: McpIdentity,
  args: { topicId?: unknown; text?: unknown },
): Promise<{ id: string } | { error: string }> {
  if (typeof args.topicId !== 'string' || args.topicId.length === 0) {
    return { error: 'topicId is required' }
  }
  if (typeof args.text !== 'string' || args.text.length === 0) {
    return { error: 'text is required' }
  }
  const id = await ctx.runMutation(internal.mcp.ops.sendMessageToTopicFromMcp, {
    userId: identity.userId,
    sessionId: identity.sessionId,
    topicId: args.topicId as Id<'topics'>,
    text: args.text,
  })
  return { id: id as string }
}
