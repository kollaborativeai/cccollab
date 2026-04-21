import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema.js'
import { api } from '../_generated/api.js'
import { dispatchMcp, PROTOCOL_VERSION } from '../mcp/server.js'

const modules = import.meta.glob('../**/*.*s')

describe('mcp dispatcher', () => {
  it('initialize returns server info + capabilities + protocol version', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const res = await t.run(async (ctx) => dispatchMcp(ctx, userId, { jsonrpc: '2.0', id: 1, method: 'initialize' }))
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'cccollab' },
        capabilities: { tools: { listChanged: false } },
      },
    })
  })

  it('ping returns empty result', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const res = await t.run(async (ctx) => dispatchMcp(ctx, userId, { jsonrpc: '2.0', id: 7, method: 'ping' }))
    expect(res).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('tools/list returns the three MCP tools', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const res = await t.run(async (ctx) => dispatchMcp(ctx, userId, { jsonrpc: '2.0', id: 2, method: 'tools/list' }))
    const tools = (res.result as { tools: Array<{ name: string }> }).tools
    expect(tools.map((tool) => tool.name).sort()).toEqual(['list_topics', 'read_topic', 'send_message_to_topic'])
  })

  it('unknown method returns JSON-RPC -32601', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const res = await t.run(async (ctx) => dispatchMcp(ctx, userId, { jsonrpc: '2.0', id: 99, method: 'nope' }))
    expect(res.error?.code).toBe(-32601)
  })

  it('tools/call list_topics returns only user-member topics', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'Bob' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: alice })
    await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    const aliceRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_topics', arguments: {} },
      }),
    )
    const aliceContent = JSON.parse((aliceRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      topics: Array<{ name: string }>
    }
    expect(aliceContent.topics.map((topic) => topic.name)).toEqual(['design'])

    const bobRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'list_topics', arguments: {} },
      }),
    )
    const bobContent = JSON.parse((bobRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      topics: unknown[]
    }
    expect(bobContent.topics).toEqual([])
  })

  it('tools/call send_message_to_topic persists a message attributed to the user', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    const res = await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'send_message_to_topic',
          arguments: { topicId, text: 'hi from alice' },
        },
      }),
    )
    const result = res.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBeFalsy()

    const msgs = await t.query(api.messages.listForTopic, { topicId })
    expect(msgs).toMatchObject([{ authorType: 'external', authorName: 'Alice', text: 'hi from alice' }])
  })

  it('tools/call read_topic returns topic with messages (including session-author messages)', async () => {
    const t = convexTest(schema, modules)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    // A "developer" session message (inserted via api.messages.send).
    await t.mutation(api.messages.send, {
      topicId,
      authorType: 'session',
      authorKey: 'dev-session',
      authorName: 'dev',
      text: 'kickoff',
    })

    const res = await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'read_topic', arguments: { topicId } },
      }),
    )
    const read = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      topic: { name: string }
      messages: Array<{ authorType: string; authorName: string; text: string }>
    }
    expect(read.topic.name).toBe('design')
    expect(read.messages).toMatchObject([{ authorType: 'session', authorName: 'dev', text: 'kickoff' }])
  })

  it('tools/call unknown tool returns JSON-RPC error', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const res = await t.run(async (ctx) =>
      dispatchMcp(ctx, userId, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'drop_table', arguments: {} },
      }),
    )
    expect(res.error?.code).toBe(-32601)
  })
})
