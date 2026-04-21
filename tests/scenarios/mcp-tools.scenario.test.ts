import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness.js'
import { api } from '../../convex/_generated/api.js'
import { dispatchMcp } from '../../convex/mcp/server.js'

describe('Scenario: MCP tools (CCC-22 AC: list_topics, read_topic, send_message_to_topic)', () => {
  it('external AI can list + read + send end-to-end', async () => {
    const { t, ensureUser } = makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, {
      name: 'eng',
      creatorUserId: alice,
    })
    const topicId = await t.mutation(api.topics.create, {
      name: 'design-review',
      channelId,
      creatorUserId: alice,
    })

    const listRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_topics', arguments: {} },
      }),
    )
    const listed = JSON.parse((listRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      topics: Array<{ id: string; name: string }>
    }
    expect(listed.topics.length).toBe(1)
    expect(listed.topics[0]!.name).toBe('design-review')

    const sendRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'send_message_to_topic',
          arguments: { topicId, text: 'hello team' },
        },
      }),
    )
    expect((sendRes.result as { isError: boolean }).isError).toBeFalsy()

    const readRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_topic', arguments: { topicId } },
      }),
    )
    const read = JSON.parse((readRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      messages: Array<{ authorType: string; authorName: string; text: string }>
    }
    expect(read.messages.length).toBe(1)
    expect(read.messages[0]!.text).toBe('hello team')
    expect(read.messages[0]!.authorType).toBe('external')
    expect(read.messages[0]!.authorName).toBe('Alice')
  })

  it('send_message_to_topic rejects empty text', async () => {
    const { t, ensureUser } = makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, {
      name: 'c',
      creatorUserId: alice,
    })
    const topicId = await t.mutation(api.topics.create, {
      name: 't',
      channelId,
      creatorUserId: alice,
    })
    const res = await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'send_message_to_topic', arguments: { topicId, text: '' } },
      }),
    )
    const result = res.result as { content: Array<{ text: string }>; isError: boolean }
    const parsed = JSON.parse(result.content[0]!.text) as { error: string }
    expect(result.isError).toBe(true)
    expect(parsed.error).toMatch(/text/i)
  })
})
