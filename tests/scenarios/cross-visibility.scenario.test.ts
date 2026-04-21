import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness.js'
import { api } from '../../convex/_generated/api.js'
import { dispatchMcp } from '../../convex/mcp/server.js'
import { buildLocalEventPayload, type ConvexMessageRow } from '../../src/bridge/convex-bridge.js'

describe('Scenario: cross-visibility (CCC-22 AC: external <-> Claude Code message visibility)', () => {
  it('message sent via MCP is translated into a /local-event payload the broker can broadcast', async () => {
    const { t, ensureUser } = makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, {
      name: 'eng',
      creatorUserId: alice,
    })
    const topicId = await t.mutation(api.topics.create, {
      name: 'design',
      channelId,
      creatorUserId: alice,
    })

    await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'send_message_to_topic',
          arguments: { topicId, text: 'from external' },
        },
      }),
    )

    const messages = await t.query(api.messages.listForTopic, { topicId })
    expect(messages.length).toBe(1)

    const row: ConvexMessageRow = {
      _id: messages[0]!._id,
      _creationTime: messages[0]!._creationTime,
      topicId: messages[0]!.topicId,
      authorType: messages[0]!.authorType,
      authorKey: messages[0]!.authorKey,
      authorName: messages[0]!.authorName,
      text: messages[0]!.text,
    }
    const payload = buildLocalEventPayload(row, { topicName: 'design', channel: 'eng' })
    expect(payload).toMatchObject({
      type: 'message',
      channel: 'eng',
      topicName: 'design',
      sender: 'Alice',
      authorType: 'external',
      text: 'from external',
    })
    // Timestamp is present and is an ISO-8601 date string
    expect(payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('message written by a Claude Code session is visible via read_topic to an external AI', async () => {
    const { t, ensureUser } = makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, {
      name: 'eng',
      creatorUserId: alice,
    })
    const topicId = await t.mutation(api.topics.create, {
      name: 'design',
      channelId,
      creatorUserId: alice,
    })

    // Simulate a message written by a Claude Code session via the session
    // author branch (what CCC-3 will use once the plugin migrates).
    await t.mutation(api.messages.send, {
      topicId,
      authorType: 'session',
      authorKey: 'dev-1',
      authorName: 'reviewer',
      text: 'dev wrote this from Claude Code',
    })

    const res = await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_topic', arguments: { topicId } },
      }),
    )
    const read = JSON.parse((res.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      messages: Array<{ authorType: string; authorName: string; text: string }>
    }
    expect(read.messages).toMatchObject([
      { authorType: 'session', authorName: 'reviewer', text: 'dev wrote this from Claude Code' },
    ])
  })

  it('both author types in the same topic survive a round-trip through the bridge payload shape', async () => {
    const { t, ensureUser } = makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    await t.mutation(api.messages.send, {
      topicId,
      authorType: 'session',
      authorKey: 'dev',
      authorName: 'reviewer',
      text: 'dev message',
    })
    await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_message_to_topic', arguments: { topicId, text: 'alice message' } },
      }),
    )

    const messages = await t.query(api.messages.listForTopic, { topicId })
    const payloads = messages.map((m) =>
      buildLocalEventPayload(
        {
          _id: m._id,
          _creationTime: m._creationTime,
          topicId: m.topicId,
          authorType: m.authorType,
          authorKey: m.authorKey,
          authorName: m.authorName,
          text: m.text,
        },
        { topicName: 'design', channel: 'eng' },
      ),
    )
    expect(payloads.map((p) => ({ sender: p.sender, authorType: p.authorType, text: p.text }))).toEqual([
      { sender: 'reviewer', authorType: 'session', text: 'dev message' },
      { sender: 'Alice', authorType: 'external', text: 'alice message' },
    ])
  })
})
