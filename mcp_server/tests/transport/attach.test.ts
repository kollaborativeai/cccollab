import { describe, it, expect, beforeEach, vi } from 'vitest'

import { ActiveContext } from '../../src/context.js'
import { SessionManager } from '../../src/session.js'
import { TransportRouter } from '../../src/transport/router.js'
import { attachLocation, type AttachCtx } from '../../src/transport/attach.js'
import type { ResolvedLocation } from '../../src/config/resolve.js'
import type { MessageBus } from '../../src/message-bus.js'
import type { ParsedMessage } from '../../src/types.js'
import {
  type Transport,
  type TransportChannel,
  type TransportSession,
  type TransportTopic,
  type TransportTopicMessage,
} from '../../src/transport/index.js'

/**
 * Remote-flavoured fake. Implements the same surface as RemoteTransport
 * plus a `subscribeDirectMessages` hook so `attachLocation` can wire
 * the DM inbox reactive feed into MessageBus the same way the real
 * RemoteTransport does.
 */
class FakeRemoteTransport implements Transport {
  readonly source: string
  enabled = true
  shouldFailIntroduce = false
  shouldFailOnceIntroduce = false
  introduceError: Error | null = null
  subscribedDms: Array<(msg: ParsedMessage) => void> = []
  dmUnsubscribeCalled = false
  private readonly topicIds = new Set<string>()
  private readonly topics = new Map<string, TransportTopic>()
  private readonly channels = new Map<string, TransportChannel>()

  introduce = vi.fn(async (_args: { sessionName: string; objective?: string }) => {
    if (this.shouldFailIntroduce || this.shouldFailOnceIntroduce) {
      this.shouldFailOnceIntroduce = false
      throw this.introduceError ?? new Error('introduce failed')
    }
  })
  joinChannel = vi.fn(async (args: { sessionName: string; channel: string }) => {
    const existing = this.channels.get(args.channel) ?? { name: args.channel, subscriberCount: 0 }
    existing.subscriberCount += 1
    this.channels.set(args.channel, existing)
    return { subscriberCount: existing.subscriberCount }
  })
  leaveChannel = vi.fn(async () => {})
  listChannels = vi.fn(async (): Promise<TransportChannel[]> => [...this.channels.values()])
  broadcast = vi.fn(async () => {})
  createTopic = vi.fn(
    async (args: { sessionName: string; channel: string; topic: string }): Promise<TransportTopic> => {
      const id = `${this.source}-topic-${this.topics.size + 1}`
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
  listTopics = vi.fn(async (): Promise<TransportTopic[]> => [...this.topics.values()])
  getTopicById = vi.fn(async (args: { sessionName: string; topicId: string }) => this.topics.get(args.topicId) ?? null)
  joinTopic = vi.fn(
    async (_args: {
      sessionName: string
      topicId: string
    }): Promise<{
      channel?: string
      history: TransportTopicMessage[]
    }> => ({ history: [] }),
  )
  leaveTopic = vi.fn(async () => {})
  archiveTopic = vi.fn(async () => {})
  unarchiveTopic = vi.fn(async () => {})
  sendTopicMessage = vi.fn(async () => {})
  listSessions = vi.fn(async (): Promise<TransportSession[]> => [])
  sendDirectMessage = vi.fn(async () => ({}))
  deregisterSession = vi.fn(async () => {})

  constructor(source: string) {
    this.source = source
  }

  hasTopic(topicId: string): boolean {
    return this.topicIds.has(topicId)
  }

  subscribeDirectMessages(onEvent: (msg: ParsedMessage) => void): () => void {
    this.subscribedDms.push(onEvent)
    return () => {
      this.dmUnsubscribeCalled = true
    }
  }

  /** Expose the topic cache so tests can pre-populate for listTopics. */
  registerTopic(t: TransportTopic): void {
    this.topics.set(t.id, t)
    this.topicIds.add(t.id)
  }

  registerChannel(c: TransportChannel): void {
    this.channels.set(c.name, c)
  }
}

function makeCtx(location: ResolvedLocation, overrides: Partial<AttachCtx> = {}): AttachCtx & { bus: MessageBus } {
  const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' })
  session.setName('architect')
  const context = new ActiveContext()
  const router = new TransportRouter([])
  const remoteUnsubscribes: Array<() => void> = []
  const busPushes: ParsedMessage[] = []
  // Minimal MessageBus stand-in. attachLocation only calls `push`.
  const bus = {
    push: vi.fn(async (msg: ParsedMessage, _source: string) => {
      void _source
      busPushes.push(msg)
    }),
  } as unknown as MessageBus & { push: ReturnType<typeof vi.fn> }
  void busPushes
  return {
    cwd: '/tmp/proj',
    env: {},
    session,
    context,
    router,
    messageBus: bus,
    remoteUnsubscribes,
    resolved: { locations: [location], activeLocation: undefined, activeChannel: undefined, activeTopic: undefined },
    transportFactory: (loc) => new FakeRemoteTransport(loc.name),
    bus,
    ...overrides,
  }
}

describe('attachLocation', () => {
  let location: ResolvedLocation

  beforeEach(() => {
    location = {
      name: 'flatout',
      isLocal: false,
      url: 'https://example.convex.cloud',
      accessToken: 'a',
      refreshToken: 'r',
      channels: [{ name: 'dev', topics: [{ name: 'planning' }] }],
    }
  })

  it('constructs the transport, introduces, and registers with the router', async () => {
    const ctx = makeCtx(location)
    const fakeFactory = vi.fn((loc: ResolvedLocation) => new FakeRemoteTransport(loc.name))
    ctx.transportFactory = fakeFactory

    const result = await attachLocation('flatout', ctx)

    expect(result.ok).toBe(true)
    expect(ctx.router.has('flatout')).toBe(true)
    const transport = ctx.router.get('flatout') as FakeRemoteTransport
    expect(transport.introduce).toHaveBeenCalledWith({ sessionName: 'architect', objective: undefined })
    expect(fakeFactory).toHaveBeenCalledTimes(1)
  })

  it('wires the DM subscription into MessageBus and stores the unsubscribe fn', async () => {
    const ctx = makeCtx(location)
    const result = await attachLocation('flatout', ctx)
    expect(result.ok).toBe(true)

    const transport = ctx.router.get('flatout') as FakeRemoteTransport
    expect(transport.subscribedDms.length).toBe(1)
    expect(ctx.remoteUnsubscribes.length).toBe(1)

    // Fire a fake DM and confirm it reached the bus with the right source tag.
    transport.subscribedDms[0]!({
      sender: 'alice',
      text: 'hi',
      ts: '2026-01-01T00:00:00Z',
      channel: 'direct',
      channelName: 'direct',
      threadTs: undefined,
    })
    const push = (ctx.messageBus as unknown as { push: ReturnType<typeof vi.fn> }).push
    expect(push).toHaveBeenCalledTimes(1)
    const [, sourceArg] = push.mock.calls[0] as [ParsedMessage, string]
    expect(sourceArg).toBe('flatout')

    // And unsubscribe is callable.
    ctx.remoteUnsubscribes[0]!()
    expect(transport.dmUnsubscribeCalled).toBe(true)
  })

  it('auto-subscribes to configured channels and topics', async () => {
    const ctx = makeCtx(location)
    const result = await attachLocation('flatout', ctx)
    expect(result.ok).toBe(true)

    const transport = ctx.router.get('flatout') as FakeRemoteTransport
    expect(transport.joinChannel).toHaveBeenCalledWith({ sessionName: 'architect', channel: 'dev' })
    expect(ctx.context.isChannelSubscribed('dev', 'flatout')).toBe(true)

    // "planning" doesn't exist on the fake yet so createTopic is called.
    expect(transport.createTopic).toHaveBeenCalledWith({
      sessionName: 'architect',
      channel: 'dev',
      topic: 'planning',
    })
  })

  it('returns ok: false and does NOT register when introduce throws', async () => {
    const ctx = makeCtx(location)
    const failing = new FakeRemoteTransport('flatout')
    failing.shouldFailIntroduce = true
    failing.introduceError = new Error('backend rejected introduce')
    ctx.transportFactory = () => failing

    const result = await attachLocation('flatout', ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('backend rejected introduce')
    expect(ctx.router.has('flatout')).toBe(false)
    expect(ctx.remoteUnsubscribes.length).toBe(0)
  })

  it('replaces an existing transport in place when one is already registered for the same name', async () => {
    const ctx = makeCtx(location)
    const old = new FakeRemoteTransport('flatout')
    ctx.router.register(old)

    const result = await attachLocation('flatout', ctx)
    expect(result.ok).toBe(true)

    // Old transport got shut down; new one is in the router.
    expect(old.deregisterSession).toHaveBeenCalledWith({ sessionName: 'architect' })
    const live = ctx.router.get('flatout')
    expect(live).not.toBe(old)
  })

  it('does not set the new location active when another location is already the runtime-active one', async () => {
    const ctx = makeCtx(location)
    // User is already active on local/dev at runtime.
    ctx.context.joinChannel('dev', 'manual', 'local')
    ctx.context.setActiveChannel('dev', 'local')

    const result = await attachLocation('flatout', ctx)
    expect(result.ok).toBe(true)

    // The prior active is preserved.
    const active = ctx.context.getActiveChannelRef()
    expect(active).toEqual({ name: 'dev', location: 'local' })
  })

  it('returns ok: false when the location is not resolvable', async () => {
    const ctx = makeCtx(location, {
      resolved: { locations: [], activeLocation: undefined, activeChannel: undefined, activeTopic: undefined },
    })
    const result = await attachLocation('flatout', ctx)
    expect(result.ok).toBe(false)
  })
})
