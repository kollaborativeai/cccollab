import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness.js'
import { api, internal } from '../../convex/_generated/api.js'
import { dispatchMcpExpectResponse as dispatchMcp } from '../../convex/mcp/server.js'

describe('Scenario: attribution (CCC-22 AC: messages posted via MCP attributed to the external user)', () => {
  it('external message is attributed to the external user, not to the developer or a generic sender', async () => {
    const { t, ensureUser } = makeHarness()
    const developer = await ensureUser('clerk_dev', 'Dev Person')
    const externalAlice = await ensureUser('clerk_alice', 'Alice External')

    const channelId = await t.mutation(api.channels.getOrCreate, {
      name: 'eng',
      creatorUserId: developer,
    })
    const topicId = await t.mutation(api.topics.create, {
      name: 'design',
      channelId,
      creatorUserId: developer,
    })
    // Alice (external) joins the topic
    await t.mutation(api.topics.join, { topicId, userId: externalAlice })

    // Developer posts a session-attributed message (simulating a Claude Code session)
    await t.mutation(internal.messages.send, {
      topicId,
      authorType: 'session',
      authorKey: 'dev-session',
      authorName: 'Developer Session',
      text: 'kicking off',
    })

    // Alice posts via MCP
    const res = await t.run(async (ctx) =>
      dispatchMcp(ctx, externalAlice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'send_message_to_topic',
          arguments: { topicId, text: 'my take' },
        },
      }),
    )
    expect((res.result as { isError: boolean }).isError).toBeFalsy()

    const messages = await t.query(api.messages.listForTopic, { topicId })
    const aliceMessage = messages.find((m) => m.text === 'my take')
    expect(aliceMessage).toBeDefined()
    expect(aliceMessage!.authorType).toBe('external')
    expect(aliceMessage!.authorName).toBe('Alice External')
    expect(aliceMessage!.authorName).not.toBe('Developer Session')
    expect(aliceMessage!.authorName).not.toBe('external')
    expect(aliceMessage!.authorKey).toBe('clerk_alice')
  })

  it('updating the external user display name updates attribution for new messages', async () => {
    const { t, ensureUser } = makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 't', channelId, creatorUserId: alice })

    await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'send_message_to_topic',
          arguments: { topicId, text: 'first' },
        },
      }),
    )

    // Rename the user via getOrCreateByClerk (simulates the user updating their Clerk profile)
    await ensureUser('clerk_alice', 'Alice Renamed')

    await t.run(async (ctx) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'send_message_to_topic',
          arguments: { topicId, text: 'second' },
        },
      }),
    )

    const messages = await t.query(api.messages.listForTopic, { topicId })
    expect(messages.map((m) => ({ text: m.text, authorName: m.authorName }))).toEqual([
      { text: 'first', authorName: 'Alice' },
      { text: 'second', authorName: 'Alice Renamed' },
    ])
  })
})
