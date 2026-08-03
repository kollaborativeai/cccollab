import { describe, it, expect, vi } from 'vitest'

import { ActiveContext } from '../../src/context.js'
import { SessionManager } from '../../src/session.js'
import { TransportRouter } from '../../src/transport/router.js'
import { handleTopicTool, type TopicToolDeps } from '../../src/tools/topics.js'
import { handleChannelTool, type ChannelToolDeps } from '../../src/tools/channels.js'
import { LocalTransport } from '../../src/transport/local.js'
import type { MessageBus } from '../../src/message-bus.js'
import type { ParsedMessage } from '../../src/types.js'
import {
  type Transport,
  type TransportChannel,
  type TransportHistoryPage,
  type TransportSession,
  type TransportTopic,
  type TransportTopicMessage,
} from '../../src/transport/index.js'

/**
 * Minimal remote-flavoured fake used to drive the tool-layer tests. Kept
 * local to this file rather than pulled out of attach.test.ts so tool
 * tests stay fully self-contained; if a third site needs this it should
 * move to a shared helper.
 */
class FakeRemoteTransport implements Transport {
  readonly source: string
  enabled = true
  subscribedTopics = new Map<
    string,
    {
      channelName: string
      onEvent: (msg: ParsedMessage) => void
      sinceTs: number | undefined
      unsubscribeCalled: boolean
    }
  >()
  primedCursors = new Map<string, number>()
  subscribedChannels = new Map<string, { onEvent: (msg: ParsedMessage) => void; unsubscribeCalled: boolean }>()
  private readonly topicIds = new Set<string>()
  private readonly topics = new Map<string, TransportTopic>()

  introduce = vi.fn(async () => {})
  joinChannel = vi.fn(async () => ({ subscriberCount: 1 }))
  leaveChannel = vi.fn(async () => {})
  listChannels = vi.fn(async (): Promise<TransportChannel[]> => [])
  broadcast = vi.fn(async () => {})
  createTopic = vi.fn(
    async (args: { sessionName: string; channel: string; topic: string }): Promise<TransportTopic> => {
      const id = `remote-topic-${this.topics.size + 1}`
      const t: TransportTopic = {
        id,
        topic: args.topic,
        channel: args.channel,
        creator: args.sessionName,
        state: 'active',
        createdAt: new Date().toISOString(),
      }
      this.topics.set(id, t)
      this.topicIds.add(id)
      return t
    },
  )
  listTopics = vi.fn(
    async (args: { sessionName?: string; channel?: string; includeArchived?: boolean }): Promise<TransportTopic[]> => {
      // Mirror RemoteTransport.listTopics: remote backends have no
      // "cross-channel" query for topics, so without a channel we
      // return empty. With a channel, filter to topics in that channel.
      void args.sessionName
      void args.includeArchived
      if (!args.channel) return []
      return [...this.topics.values()].filter((t) => t.channel === args.channel)
    },
  )
  getTopicById = vi.fn(async (args: { sessionName: string; topicId: string }) => this.topics.get(args.topicId) ?? null)
  joinTopic = vi.fn(
    async (_args: {
      sessionName: string
      topicId: string
    }): Promise<{ channel?: string; history: TransportTopicMessage[] }> => ({
      history: [],
    }),
  )
  leaveTopic = vi.fn(async () => {})
  archiveTopic = vi.fn(async () => {})
  unarchiveTopic = vi.fn(async () => {})
  sendTopicMessage = vi.fn(async () => {})
  listSessions = vi.fn(async (): Promise<TransportSession[]> => [])
  deregisterSession = vi.fn(async () => {})
  readChannelMessages = vi.fn(
    async (_args: { channel: string; limit?: number; before?: number }): Promise<TransportHistoryPage> => ({
      messages: [],
      hasMore: false,
    }),
  )
  readTopicMessages = vi.fn(
    async (_args: { topicId: string; limit?: number; before?: number }): Promise<TransportHistoryPage> => ({
      messages: [],
      hasMore: false,
    }),
  )

  constructor(source: string) {
    this.source = source
  }

  hasTopic(topicId: string): boolean {
    return this.topicIds.has(topicId)
  }

  subscribeTopicMessages(
    args: { topicId: string; channelName: string },
    onEvent: (msg: ParsedMessage) => void,
  ): () => void {
    const entry = {
      channelName: args.channelName,
      onEvent,
      sinceTs: this.primedCursors.get(args.topicId),
      unsubscribeCalled: false,
    }
    this.subscribedTopics.set(args.topicId, entry)
    return () => {
      entry.unsubscribeCalled = true
    }
  }

  primeTopicCursor(topicId: string, ts: number): void {
    const prior = this.primedCursors.get(topicId) ?? 0
    if (ts > prior) this.primedCursors.set(topicId, ts)
  }

  registerTopic(t: TransportTopic): void {
    this.topics.set(t.id, t)
    this.topicIds.add(t.id)
  }

  subscribeChannelMessages(args: { channelName: string }, onEvent: (msg: ParsedMessage) => void): () => void {
    const entry = { onEvent, unsubscribeCalled: false }
    this.subscribedChannels.set(args.channelName, entry)
    return () => {
      entry.unsubscribeCalled = true
    }
  }
}

function makeRemoteDeps(): {
  deps: TopicToolDeps
  transport: FakeRemoteTransport
  bus: MessageBus & { push: ReturnType<typeof vi.fn> }
  unsubscribes: Map<string, () => void>
} {
  const session = new SessionManager({ username: 'tester', cwd: '/tmp/p' })
  session.setName('architect')
  const context = new ActiveContext()
  context.joinChannel('dev', 'cccollab.json', 'acme')
  const transport = new FakeRemoteTransport('acme')
  const router = new TransportRouter([new LocalTransport(0), transport])
  const bus = {
    push: vi.fn(async () => {}),
  } as unknown as MessageBus & { push: ReturnType<typeof vi.fn> }
  const unsubscribes = new Map<string, () => void>()
  const deps: TopicToolDeps = {
    session,
    context,
    router,
    messageBus: bus,
    remoteTopicUnsubscribes: unsubscribes,
  }
  return { deps, transport, bus, unsubscribes }
}

describe('tool-layer remote topic subscriptions', () => {
  it('start_topic wires a topic-message subscription on the remote transport', async () => {
    const { deps, transport, unsubscribes } = makeRemoteDeps()
    const res = JSON.parse(
      await handleTopicTool('start_topic', { topic: 'cross-machine', channel: 'dev', location: 'acme' }, deps),
    )
    expect(res.id).toBeDefined()
    expect(transport.subscribedTopics.has(res.id)).toBe(true)
    const sub = transport.subscribedTopics.get(res.id)!
    expect(sub.channelName).toBe('dev')
    expect(unsubscribes.has(`acme::${res.id}`)).toBe(true)
  })

  it('archive_topic keeps the archiver joined and subscribed (KAI-373)', async () => {
    const { deps, transport, unsubscribes } = makeRemoteDeps()
    const startRes = JSON.parse(
      await handleTopicTool('start_topic', { topic: 'cross-machine', channel: 'dev', location: 'acme' }, deps),
    )
    const topicId = startRes.id as string
    expect(transport.subscribedTopics.get(topicId)!.unsubscribeCalled).toBe(false)

    const archived = JSON.parse(await handleTopicTool('archive_topic', {}, deps))
    expect(archived.id).toBe(topicId)
    // Archiving must not drop the archiver's own membership or live subscription
    // — peers keep both, so the archiver stays symmetric with them and keeps
    // receiving the topic's own unarchive event (KAI-373).
    expect(deps.context.isTopicJoined(topicId)).toBe(true)
    expect(transport.subscribedTopics.get(topicId)!.unsubscribeCalled).toBe(false)
    expect(unsubscribes.has(`acme::${topicId}`)).toBe(true)
  })

  it('unarchive_topic re-establishes membership and subscription on the remote transport (KAI-373)', async () => {
    const { deps, transport, unsubscribes } = makeRemoteDeps()
    const topicId = 'abcdefghij0123456789' // matches looksLikeTopicId's convex-id shape
    transport.registerTopic({
      id: topicId,
      topic: 'cross-machine',
      channel: 'dev',
      creator: 'someone',
      state: 'archived',
      createdAt: '2026-04-20T00:00:00Z',
    })

    const res = JSON.parse(await handleTopicTool('unarchive_topic', { topic: topicId }, deps))
    expect(res.id).toBe(topicId)
    expect(transport.unarchiveTopic).toHaveBeenCalledWith({ sessionName: 'architect', topicId })
    // The unarchiver is joined again and re-subscribed to live updates.
    expect(deps.context.isTopicJoined(topicId)).toBe(true)
    expect(transport.subscribedTopics.has(topicId)).toBe(true)
    expect(unsubscribes.has(`acme::${topicId}`)).toBe(true)
  })

  it('leave_topic tears down the topic subscription on the remote transport', async () => {
    const { deps, transport, unsubscribes } = makeRemoteDeps()
    const startRes = JSON.parse(
      await handleTopicTool('start_topic', { topic: 'cross-machine', channel: 'dev', location: 'acme' }, deps),
    )
    const topicId = startRes.id as string
    expect(transport.subscribedTopics.get(topicId)!.unsubscribeCalled).toBe(false)

    const leaveRes = JSON.parse(await handleTopicTool('leave_topic', {}, deps))
    expect(leaveRes.id).toBe(topicId)
    expect(transport.subscribedTopics.get(topicId)!.unsubscribeCalled).toBe(true)
    expect(unsubscribes.has(`acme::${topicId}`)).toBe(false)
  })

  it('join_topic wires a subscription and primes the cursor past the returned history', async () => {
    const { deps, transport, unsubscribes } = makeRemoteDeps()
    // Seed the fake with an existing topic so the tool hits joinTopic,
    // not createTopic, and return some history so the priming branch is
    // exercised.
    const topicId = 'abcdefghij0123456789' // matches looksLikeTopicId's convex-id shape
    transport.registerTopic({
      id: topicId,
      topic: 'cross-machine',
      channel: 'dev',
      creator: 'someone',
      state: 'active',
      createdAt: '2026-04-20T00:00:00Z',
    })
    transport.joinTopic = vi.fn(async () => ({
      channel: 'dev',
      history: [
        { sender: 'peer', text: 'old-1', ts: '2026-04-20T00:00:00.000Z' },
        { sender: 'peer', text: 'old-2', ts: '2026-04-20T00:00:01.000Z' },
      ],
    }))

    const res = JSON.parse(await handleTopicTool('join_topic', { topic: topicId }, deps))
    expect(res.id).toBe(topicId)
    expect(transport.subscribedTopics.has(topicId)).toBe(true)
    const sub = transport.subscribedTopics.get(topicId)!
    expect(sub.sinceTs).toBe(Date.parse('2026-04-20T00:00:01.000Z'))
    expect(unsubscribes.has(`acme::${topicId}`)).toBe(true)
  })
})

describe('tool-layer remote list_topics (bug A)', () => {
  it('list_topics with no channel arg returns topics from subscribed remote channels', async () => {
    // Bug A regression: handleListTopics's no-channel path called
    // transport.listTopics({sessionName, includeArchived}) with no
    // channel, which RemoteTransport.listTopics short-circuits to []
    // because there is no efficient cross-channel server-side query.
    // The tool must iterate the session's subscribed channels at each
    // transport's location and call listTopics per channel.
    const { deps, transport } = makeRemoteDeps()
    transport.registerTopic({
      id: 'abcdefghij0123456789',
      topic: 'planning',
      channel: 'dev',
      creator: 'someone',
      state: 'active',
      createdAt: '2026-04-22T00:00:00Z',
    })
    const rows = JSON.parse(await handleTopicTool('list_topics', {}, deps)) as Array<{
      id: string
      name: string
      channel: string
      location: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'abcdefghij0123456789',
      name: 'planning',
      channel: 'dev',
      location: 'acme',
    })
  })
})

describe('tool-layer remote channel subscriptions (bug B)', () => {
  function makeChannelDeps(): {
    deps: ChannelToolDeps
    transport: FakeRemoteTransport
    channelUnsubs: Map<string, () => void>
  } {
    const session = new SessionManager({ username: 'tester', cwd: '/tmp/p' })
    session.setName('architect')
    const context = new ActiveContext()
    const transport = new FakeRemoteTransport('acme')
    const router = new TransportRouter([new LocalTransport(0), transport])
    const channelUnsubs = new Map<string, () => void>()
    const bus = { push: vi.fn(async () => {}) } as unknown as MessageBus
    const deps: ChannelToolDeps = {
      session,
      context,
      router,
      locations: [
        { name: 'local', isLocal: true },
        { name: 'flatout', isLocal: false },
      ],
      messageBus: bus,
      remoteChannelUnsubscribes: channelUnsubs,
    }
    return { deps, transport, channelUnsubs }
  }

  it('join_channel wires a channel-broadcast subscription on the remote transport', async () => {
    const { deps, transport, channelUnsubs } = makeChannelDeps()
    const res = JSON.parse(await handleChannelTool('join_channel', { name: 'dev', location: 'acme' }, deps))
    expect(res.channel).toBe('dev')
    expect(transport.subscribedChannels.has('dev')).toBe(true)
    expect(channelUnsubs.has('acme::dev')).toBe(true)
  })

  it('leave_channel tears down the channel-broadcast subscription', async () => {
    const { deps, transport, channelUnsubs } = makeChannelDeps()
    await handleChannelTool('join_channel', { name: 'dev', location: 'acme' }, deps)
    const sub = transport.subscribedChannels.get('dev')!
    expect(sub.unsubscribeCalled).toBe(false)

    const res = JSON.parse(await handleChannelTool('leave_channel', { name: 'dev', location: 'acme' }, deps))
    expect(res.removed).toBe(true)
    expect(sub.unsubscribeCalled).toBe(true)
    expect(channelUnsubs.has('acme::dev')).toBe(false)
  })
})
