import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness.js'
import { api, internal } from '../../convex/_generated/api.js'
import { dispatchMcpExpectResponse as dispatchMcp } from '../../convex/mcp/server.js'
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

    const hydrated = await t.query(api.messages.listRecent, {})
    expect(hydrated.length).toBe(1)
    const row: ConvexMessageRow = {
      _id: hydrated[0]!._id,
      _creationTime: hydrated[0]!._creationTime,
      topicId: hydrated[0]!.topicId,
      authorType: hydrated[0]!.authorType,
      authorKey: hydrated[0]!.authorKey,
      authorName: hydrated[0]!.authorName,
      text: hydrated[0]!.text,
      topicName: hydrated[0]!.topicName,
      channelName: hydrated[0]!.channelName,
    }
    const payload = buildLocalEventPayload(row)
    expect(payload).toMatchObject({
      type: 'message',
      channel: 'eng',
      topicName: 'design',
      sender: 'Alice',
      authorType: 'external',
      text: 'from external',
    })
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
    await t.mutation(internal.messages.send, {
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

    await t.mutation(internal.messages.send, {
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

    const hydrated = await t.query(api.messages.listRecent, {})
    const payloads = hydrated.map((m) =>
      buildLocalEventPayload({
        _id: m._id,
        _creationTime: m._creationTime,
        topicId: m.topicId,
        authorType: m.authorType,
        authorKey: m.authorKey,
        authorName: m.authorName,
        text: m.text,
        topicName: m.topicName,
        channelName: m.channelName,
      }),
    )
    expect(payloads.map((p) => ({ sender: p.sender, authorType: p.authorType, text: p.text }))).toEqual([
      { sender: 'reviewer', authorType: 'session', text: 'dev message' },
      { sender: 'Alice', authorType: 'external', text: 'alice message' },
    ])
    // All payloads carry the real channel + topic name (not the "external" placeholder).
    expect(payloads.every((p) => p.channel === 'eng' && p.topicName === 'design')).toBe(true)
  })
})
