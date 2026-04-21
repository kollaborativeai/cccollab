import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness.js'
import { api } from '../../convex/_generated/api.js'
import { dispatchMcpExpectResponse as dispatchMcp } from '../../convex/mcp/server.js'

describe('Scenario: per-user scoping (CCC-22 AC: tools scoped to authenticated user memberships)', () => {
  it('non-members cannot list, read, or send to a topic', async () => {
    const { t, ensureUser } = makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const bob = await ensureUser('clerk_bob', 'Bob')
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, {
      name: 'design',
      channelId,
      creatorUserId: alice,
    })

    // Bob has no membership. list_topics returns empty.
    const listRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_topics', arguments: {} },
      }),
    )
    const listed = JSON.parse((listRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      topics: unknown[]
    }
    expect(listed.topics).toEqual([])

    // read_topic returns a structured error — topic is invisible to Bob.
    const readRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_topic', arguments: { topicId } },
      }),
    )
    const readParsed = JSON.parse((readRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      error: string
    }
    expect(readParsed.error).toBe('topic_not_found_or_not_a_member')

    // send_message_to_topic returns a member-gated error.
    const sendRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'send_message_to_topic',
          arguments: { topicId, text: 'sneak in' },
        },
      }),
    )
    const sendParsed = JSON.parse((sendRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      error: string
    }
    expect(sendParsed.error).toMatch(/not a member/i)

    // And no message was persisted.
    const msgs = await t.query(api.messages.listForTopic, { topicId })
    expect(msgs.length).toBe(0)
  })

  it('after explicit join, the previously excluded user can list/read/send', async () => {
    const { t, ensureUser } = makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const bob = await ensureUser('clerk_bob', 'Bob')
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'dr', channelId, creatorUserId: alice })
    await t.mutation(api.topics.join, { topicId, userId: bob })

    const sendRes = await t.run(async (ctx) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_message_to_topic', arguments: { topicId, text: 'hello' } },
      }),
    )
    expect((sendRes.result as { isError: boolean }).isError).toBeFalsy()

    const msgs = await t.query(api.messages.listForTopic, { topicId })
    expect(msgs.map((m) => ({ authorName: m.authorName, text: m.text }))).toEqual([
      { authorName: 'Bob', text: 'hello' },
    ])
  })
})
