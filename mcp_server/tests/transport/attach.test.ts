import { describe, it, expect, beforeEach, vi } from 'vitest'

import { ActiveContext } from '../../src/context.js'
import { SessionManager } from '../../src/session.js'
import { TransportRouter } from '../../src/transport/router.js'
import {
  attachLocation,
  defaultTransportFactory,
  ensureLazyAttach,
  planStartupAttachments,
  type AttachCtx,
  type AttachResolved,
  type LazyAttachCtx,
} from '../../src/transport/attach.js'
import { AttachDiagnostics } from '../../src/transport/diagnostics.js'
import type { ResolvedLocation } from '../../src/config/resolve.js'
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
 * Remote-flavoured fake. Implements the same surface as RemoteTransport
 * plus a `subscribeTopicMessages` hook so `attachLocation` can wire the
 * per-topic reactive feeds into MessageBus the same way the real
 * RemoteTransport does.
 */
class FakeRemoteTransport implements Transport {
  readonly source: string
  enabled = true
  shouldFailIntroduce = false
  shouldFailOnceIntroduce = false
  introduceError: Error | null = null
  /** Per-topic subscription state: keeps the callback, the channel name
   *  it was registered with, the cursor that was in place at subscribe
   *  time, and a flag recording whether the returned unsubscribe fn has
   *  been invoked. Lets tests fire fake messages and assert teardown. */
  subscribedTopics = new Map<
    string,
    {
      channelName: string
      onEvent: (msg: ParsedMessage) => void
      sinceTs: number | undefined
      unsubscribeCalled: boolean
    }
  >()
  /** Topic ids for which `primeTopicCursor` has been called, mapped to
   *  the highest ts passed to prime. Subscribe reads this to seed the
   *  recorded `sinceTs`. */
  primedCursors = new Map<string, number>()
  /** Per-channel subscription state, keyed by channel name. Mirrors
   *  `subscribedTopics` for the channel-broadcast wiring added by bug B. */
  subscribedChannels = new Map<string, { onEvent: (msg: ParsedMessage) => void; unsubscribeCalled: boolean }>()
  shutdownCalled = false
  shutdown = vi.fn(async (): Promise<void> => {
    this.shutdownCalled = true
    this.enabled = false
  })
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
      // Match real behaviour: first-call wins, subsequent invocations
      // are no-ops. We keep the entry in the map so tests can inspect it.
    }
  }

  primeTopicCursor(topicId: string, ts: number): void {
    const prior = this.primedCursors.get(topicId) ?? 0
    if (ts > prior) this.primedCursors.set(topicId, ts)
  }

  subscribeChannelMessages(args: { channelName: string }, onEvent: (msg: ParsedMessage) => void): () => void {
    const entry = { onEvent, unsubscribeCalled: false }
    this.subscribedChannels.set(args.channelName, entry)
    return () => {
      entry.unsubscribeCalled = true
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
  const remoteTopicUnsubscribes = new Map<string, () => void>()
  const remoteChannelUnsubscribes = new Map<string, () => void>()
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
    session,
    context,
    router,
    messageBus: bus,
    remoteTopicUnsubscribes,
    remoteChannelUnsubscribes,
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
      name: 'acme',
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

    const result = await attachLocation('acme', ctx)

    expect(result.ok).toBe(true)
    expect(ctx.router.has('acme')).toBe(true)
    const transport = ctx.router.get('acme') as FakeRemoteTransport
    expect(transport.introduce).toHaveBeenCalledWith({ sessionName: 'architect', objective: undefined })
    expect(fakeFactory).toHaveBeenCalledTimes(1)
  })

  it('auto-subscribes to configured channels and topics', async () => {
    const ctx = makeCtx(location)
    const result = await attachLocation('acme', ctx)
    expect(result.ok).toBe(true)

    const transport = ctx.router.get('acme') as FakeRemoteTransport
    expect(transport.joinChannel).toHaveBeenCalledWith({ sessionName: 'architect', channel: 'dev' })
    expect(ctx.context.isChannelSubscribed('dev', 'acme')).toBe(true)

    // "planning" doesn't exist on the fake yet so createTopic is called.
    expect(transport.createTopic).toHaveBeenCalledWith({
      sessionName: 'architect',
      channel: 'dev',
      topic: 'planning',
    })
  })

  it('returns ok: false and does NOT register when introduce throws', async () => {
    const ctx = makeCtx(location)
    const failing = new FakeRemoteTransport('acme')
    failing.shouldFailIntroduce = true
    failing.introduceError = new Error('backend rejected introduce')
    ctx.transportFactory = () => failing

    const result = await attachLocation('acme', ctx)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('backend rejected introduce')
    expect(ctx.router.has('acme')).toBe(false)
  })

  it('shuts down the orphaned transport when introduce throws, so its ConvexClient websocket does not leak', async () => {
    // Regression guard for KAI-368: a constructed-but-never-registered
    // transport (introduce failed) must be torn down. Otherwise its
    // ConvexClient websocket + auth fetcher keep running with no owner,
    // and a subsequent background "Server Error" rejection can crash the
    // whole process — bricking the local broker for every session.
    const ctx = makeCtx(location)
    const failing = new FakeRemoteTransport('acme')
    failing.shouldFailIntroduce = true
    failing.introduceError = new Error('Server Error')
    ctx.transportFactory = () => failing

    const result = await attachLocation('acme', ctx)

    expect(result.ok).toBe(false)
    expect(failing.shutdown).toHaveBeenCalledTimes(1)
    expect(failing.shutdownCalled).toBe(true)
  })

  it('records the failure in diagnostics when introduce throws', async () => {
    // KAI-368: the failed remote is not registered in the router, so the
    // separate diagnostics registry is how whoami surfaces "✗ personal".
    const diagnostics = new AttachDiagnostics()
    const ctx = makeCtx(location, { diagnostics })
    const failing = new FakeRemoteTransport('acme')
    failing.shouldFailIntroduce = true
    failing.introduceError = new Error('Server Error')
    ctx.transportFactory = () => failing

    const result = await attachLocation('acme', ctx)

    expect(result.ok).toBe(false)
    expect(diagnostics.get('acme')?.reason).toContain('Server Error')
  })

  it('clears a prior diagnostics failure once the location attaches successfully', async () => {
    const diagnostics = new AttachDiagnostics()
    diagnostics.recordFailure('acme', 'earlier introduce() failure')
    const ctx = makeCtx(location, { diagnostics })

    const result = await attachLocation('acme', ctx)

    expect(result.ok).toBe(true)
    expect(diagnostics.get('acme')).toBeUndefined()
  })

  it('replaces an existing transport in place when one is already registered for the same name', async () => {
    const ctx = makeCtx(location)
    const old = new FakeRemoteTransport('acme')
    ctx.router.register(old)

    const result = await attachLocation('acme', ctx)
    expect(result.ok).toBe(true)

    // Old transport got shut down; new one is in the router.
    expect(old.deregisterSession).toHaveBeenCalledWith({ sessionName: 'architect' })
    const live = ctx.router.get('acme')
    expect(live).not.toBe(old)
  })

  it('tears down the prior transport fully on force-reauth: old shutdown runs, router points at the new one', async () => {
    // Simulates the `authenticate({location, force: true})` path. We
    // attach once, then attach again with a fresh factory output. The
    // old transport's `shutdown()` MUST be called, it MUST be
    // deregistered, and the router MUST resolve to the new transport.
    // This is the regression guard for the pre-fix leak where the old
    // ConvexClient websocket stayed open.
    const ctx = makeCtx(location)

    // First attach
    const first = await attachLocation('acme', ctx)
    expect(first.ok).toBe(true)
    const originalTransport = ctx.router.get('acme') as FakeRemoteTransport

    // Prepare a distinct new transport for the second attach.
    const replacement = new FakeRemoteTransport('acme')
    ctx.transportFactory = () => replacement

    // Second attach (what `authenticate({force:true})` triggers).
    const second = await attachLocation('acme', ctx)
    expect(second.ok).toBe(true)

    // 1. Old transport's shutdown() was called.
    expect(originalTransport.shutdown).toHaveBeenCalledTimes(1)
    expect(originalTransport.shutdownCalled).toBe(true)
    // 2. Old transport got a deregisterSession too.
    expect(originalTransport.deregisterSession).toHaveBeenCalledWith({ sessionName: 'architect' })
    // 3. Router now points at the replacement.
    const live = ctx.router.get('acme') as FakeRemoteTransport
    expect(live).toBe(replacement)
    expect(live).not.toBe(originalTransport)
  })

  it('does not set the new location active when another location is already the runtime-active one', async () => {
    const ctx = makeCtx(location)
    // User is already active on local/dev at runtime.
    ctx.context.joinChannel('dev', 'manual', 'local')
    ctx.context.setActiveChannel('dev', 'local')

    const result = await attachLocation('acme', ctx)
    expect(result.ok).toBe(true)

    // The prior active is preserved.
    const active = ctx.context.getActiveChannelRef()
    expect(active).toEqual({ name: 'dev', location: 'local' })
  })

  it('returns ok: false when the location is not resolvable', async () => {
    const ctx = makeCtx(location, {
      resolved: { locations: [], activeLocation: undefined, activeChannel: undefined, activeTopic: undefined },
    })
    const result = await attachLocation('acme', ctx)
    expect(result.ok).toBe(false)
  })

  it('subscribes to messages for each auto-joined topic and pushes inbound messages into MessageBus', async () => {
    // This is the regression guard for the "two remote sessions joined
    // the same topic but messages never cross" bug: attachLocation must
    // establish a `subscribeTopicMessages` per auto-subscribed topic,
    // not just a server-side membership row via `joinTopic`.
    const ctx = makeCtx(location)
    const result = await attachLocation('acme', ctx)
    expect(result.ok).toBe(true)

    const transport = ctx.router.get('acme') as FakeRemoteTransport
    // The cccollab.json configured exactly one topic ("planning") under
    // "dev". `attachLocation` should have created it (listTopics was
    // empty) and subscribed to its message stream.
    expect(transport.subscribedTopics.size).toBe(1)
    const [topicId, sub] = [...transport.subscribedTopics.entries()][0]!
    expect(sub.channelName).toBe('dev')

    // The per-topic subscription key is stored in remoteTopicUnsubscribes
    // so the shutdown / teardown paths can find it.
    expect(ctx.remoteTopicUnsubscribes.size).toBe(1)
    expect(ctx.remoteTopicUnsubscribes.has(`acme::${topicId}`)).toBe(true)

    // Fire a fake topic message through the subscription callback. It
    // must reach MessageBus.push with the location as the source tag.
    sub.onEvent({
      sender: 'peer',
      text: 'hello from peer',
      ts: '2026-04-21T00:00:00Z',
      channel: 'dev',
      channelName: 'dev',
      threadTs: topicId,
    })
    const push = (ctx.messageBus as unknown as { push: ReturnType<typeof vi.fn> }).push
    expect(push).toHaveBeenCalled()
    const [msg, sourceArg] = push.mock.calls[0] as [ParsedMessage, string]
    expect(msg.text).toBe('hello from peer')
    expect(msg.threadTs).toBe(topicId)
    expect(sourceArg).toBe('acme')
  })

  it('primes the topic cursor from joinTopic history so auto-subscribe does not replay past messages', async () => {
    // Pre-populate an existing topic on the fake so the auto-subscribe
    // path goes down joinTopic (not createTopic), and make joinTopic
    // return history so attachLocation can prime the cursor past it.
    const ctx = makeCtx(location)
    const fake = new FakeRemoteTransport('acme')
    fake.registerTopic({
      id: 'topic-existing',
      topic: 'planning',
      channel: 'dev',
      creator: 'someone',
      state: 'active',
      createdAt: '2026-04-20T00:00:00Z',
    })
    fake.joinTopic = vi.fn(async () => ({
      channel: 'dev',
      history: [
        { sender: 'peer', text: 'old-1', ts: '2026-04-20T00:00:00.000Z' },
        { sender: 'peer', text: 'old-2', ts: '2026-04-20T00:00:01.000Z' },
      ],
    }))
    ctx.transportFactory = () => fake

    const result = await attachLocation('acme', ctx)
    expect(result.ok).toBe(true)
    // Cursor primed to the highest history ts.
    const primed = fake.primedCursors.get('topic-existing')
    expect(primed).toBe(Date.parse('2026-04-20T00:00:01.000Z'))
    const sub = fake.subscribedTopics.get('topic-existing')
    expect(sub?.sinceTs).toBe(Date.parse('2026-04-20T00:00:01.000Z'))
  })

  it('subscribes to channel messages for each auto-joined channel and pushes inbound messages into MessageBus', async () => {
    // Regression guard for bug B (channel broadcasts on a remote location
    // don't reach other subscribers). attachLocation must wire
    // subscribeChannelMessages for each configured channel so broadcasts
    // travel back through MessageBus just like topic messages and DMs do.
    const ctx = makeCtx(location)
    const result = await attachLocation('acme', ctx)
    expect(result.ok).toBe(true)

    const transport = ctx.router.get('acme') as FakeRemoteTransport
    expect(transport.subscribedChannels.size).toBe(1)
    const sub = transport.subscribedChannels.get('dev')!
    expect(ctx.remoteChannelUnsubscribes.size).toBe(1)
    expect(ctx.remoteChannelUnsubscribes.has('acme::dev')).toBe(true)

    sub.onEvent({
      sender: 'peer',
      text: 'hello-from-peer-on-dev',
      ts: '2026-04-22T13:42:00Z',
      channel: 'dev',
      channelName: 'dev',
      threadTs: undefined,
    })
    const push = (ctx.messageBus as unknown as { push: ReturnType<typeof vi.fn> }).push
    expect(push).toHaveBeenCalled()
    const [msg, sourceArg] = push.mock.calls[0] as [ParsedMessage, string]
    expect(msg.text).toBe('hello-from-peer-on-dev')
    expect(msg.channel).toBe('dev')
    expect(sourceArg).toBe('acme')
  })

  it('tears down topic subscriptions on prior-transport replace (force re-authenticate)', async () => {
    const ctx = makeCtx(location)
    const first = await attachLocation('acme', ctx)
    expect(first.ok).toBe(true)

    const originalTransport = ctx.router.get('acme') as FakeRemoteTransport
    const topicKey = [...ctx.remoteTopicUnsubscribes.keys()][0]!
    const topicId = topicKey.slice('acme::'.length)
    const priorSub = originalTransport.subscribedTopics.get(topicId)!

    // Replace-in-place attach (what `authenticate({force:true})` does).
    const replacement = new FakeRemoteTransport('acme')
    ctx.transportFactory = () => replacement
    const second = await attachLocation('acme', ctx)
    expect(second.ok).toBe(true)

    // Prior topic subscription was torn down, the map no longer points at
    // it, and the replacement has its own.
    expect(priorSub.unsubscribeCalled).toBe(true)
    expect(ctx.remoteTopicUnsubscribes.size).toBe(1)
    expect([...ctx.remoteTopicUnsubscribes.keys()][0]!.startsWith('acme::')).toBe(true)
    expect(replacement.subscribedTopics.size).toBe(1)
  })
})

describe('planStartupAttachments', () => {
  /** Build a ResolvedLocation with sane non-local defaults; override per case. */
  function loc(partial: Partial<ResolvedLocation> & { name: string }): ResolvedLocation {
    return {
      isLocal: false,
      url: 'https://example.convex.cloud',
      accessToken: 'a',
      refreshToken: 'r',
      clerkIssuer: 'https://example.clerk.accounts.dev',
      clerkClientId: 'cid',
      channels: [],
      ...partial,
    }
  }

  const localLoc = (channels: ResolvedLocation['channels'] = []): ResolvedLocation => ({
    name: 'local',
    isLocal: true,
    channels,
  })

  it('never includes the local location in the attach list', () => {
    const plan = planStartupAttachments([localLoc([{ name: 'cccollab', topics: [] }])], 'local')
    expect(plan.attach.map((l) => l.name)).not.toContain('local')
    expect(plan.skipped.find((s) => s.name === 'local')?.reason).toBe('local')
  })

  it('skips a dormant remote (not active, no channels) quietly even when fully constructable', () => {
    // The KAI case: token-bearing, Clerk-configured, but the user is working
    // locally and never opted this location in. Must not attach → no remote
    // round-trip at startup.
    const plan = planStartupAttachments([localLoc(), loc({ name: 'remote' })], 'local')
    expect(plan.attach).toHaveLength(0)
    expect(plan.skipped.find((s) => s.name === 'remote')?.reason).toBe('dormant')
  })

  it('attaches a remote that is the active location', () => {
    const plan = planStartupAttachments([localLoc(), loc({ name: 'remote' })], 'remote')
    expect(plan.attach.map((l) => l.name)).toEqual(['remote'])
  })

  it('attaches a non-active remote that has configured channels (README auto-subscribe contract)', () => {
    const plan = planStartupAttachments(
      [localLoc(), loc({ name: 'remote', channels: [{ name: 'dev', topics: [] }] })],
      'local',
    )
    expect(plan.attach.map((l) => l.name)).toEqual(['remote'])
  })

  it('skips an engaged-but-legacy remote (missing Clerk pointer) as not-constructable', () => {
    const legacy = loc({ name: 'acme', clerkIssuer: undefined, clerkClientId: undefined })
    const plan = planStartupAttachments([localLoc(), legacy], 'acme')
    expect(plan.attach).toHaveLength(0)
    expect(plan.skipped.find((s) => s.name === 'acme')?.reason).toBe('not-constructable')
  })

  it('skips an engaged remote with no tokens, flagging no-tokens', () => {
    const noTok = loc({ name: 'remote', accessToken: undefined, refreshToken: undefined })
    const plan = planStartupAttachments([localLoc(), noTok], 'remote')
    expect(plan.attach).toHaveLength(0)
    expect(plan.skipped.find((s) => s.name === 'remote')?.reason).toBe('no-tokens')
  })

  it('skips an engaged remote with no url, flagging no-url', () => {
    const noUrl = loc({ name: 'remote', url: undefined })
    const plan = planStartupAttachments([localLoc(), noUrl], 'remote')
    expect(plan.attach).toHaveLength(0)
    expect(plan.skipped.find((s) => s.name === 'remote')?.reason).toBe('no-url')
  })

  it('mirrors the real polluted config: local active + dormant KAI remotes → attach nothing, all quiet', () => {
    const locations = [
      loc({ name: 'remote' }), // KAI, constructable, dormant
      loc({ name: 'tow123', clerkIssuer: undefined, clerkClientId: undefined }), // KAI deploy, no Clerk pointer, dormant
      localLoc([{ name: 'cccollab', topics: [] }]),
    ]
    const plan = planStartupAttachments(locations, 'local')
    expect(plan.attach).toHaveLength(0)
    // Dormant skips are the quiet kind - never surfaced as errors.
    expect(plan.skipped.every((s) => s.reason === 'dormant' || s.reason === 'local')).toBe(true)
  })
})

describe('defaultTransportFactory', () => {
  const clerkLoc = (url: string): ResolvedLocation => ({
    name: 'kai',
    isLocal: false,
    url,
    clerkIssuer: 'https://x.clerk.accounts.dev',
    clerkClientId: 'cccollab-cli',
    idToken: 'id',
    refreshToken: 'rt',
    accessToken: 'at',
    accessTokenExpiresAt: Date.now() + 60_000,
    channels: [],
  })

  it('refuses a non-HTTPS, non-loopback deployment URL (would leak the ID token over plaintext)', () => {
    expect(() => defaultTransportFactory(clerkLoc('http://kai.example.com'))).toThrow(
      /Refusing to send Bearer token to a non-HTTPS endpoint/,
    )
  })

  it('allows an HTTPS deployment URL', () => {
    expect(() => defaultTransportFactory(clerkLoc('https://kai.convex.cloud'))).not.toThrow()
  })

  it('allows a loopback http deployment URL (local convex dev)', () => {
    expect(() => defaultTransportFactory(clerkLoc('http://127.0.0.1:8001'))).not.toThrow()
  })
})

describe('ensureLazyAttach', () => {
  /** A fully constructable, token-bearing non-local location — the shape a
   *  dormant remote has on disk after a prior `authenticate`. */
  function constructable(name: string): ResolvedLocation {
    return {
      name,
      isLocal: false,
      url: 'https://example.convex.cloud',
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      clerkIssuer: 'https://example.clerk.accounts.dev',
      clerkClientId: 'cid',
      channels: [],
    }
  }

  function makeLazyCtx(
    locations: ResolvedLocation[],
    overrides: Partial<LazyAttachCtx> = {},
  ): { ctx: LazyAttachCtx; resolve: ReturnType<typeof vi.fn>; factory: ReturnType<typeof vi.fn> } {
    const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' })
    session.setName('architect')
    const context = new ActiveContext()
    const router = new TransportRouter([])
    const bus = { push: vi.fn(async () => {}) } as unknown as MessageBus
    const resolve = vi.fn(
      (): AttachResolved => ({
        locations,
        activeLocation: undefined,
        activeChannel: undefined,
        activeTopic: undefined,
      }),
    )
    const factory = vi.fn((loc: ResolvedLocation) => new FakeRemoteTransport(loc.name))
    const ctx: LazyAttachCtx = {
      session,
      context,
      router,
      messageBus: bus,
      remoteTopicUnsubscribes: new Map<string, () => void>(),
      remoteChannelUnsubscribes: new Map<string, () => void>(),
      inflight: new Map<string, Promise<void>>(),
      candidates: locations.filter((l) => !l.isLocal).map((l) => l.name),
      resolve,
      transportFactory: factory,
      ...overrides,
    }
    return { ctx, resolve, factory }
  }

  it('attaches a dormant token-bearing location on first call', async () => {
    const { ctx } = makeLazyCtx([constructable('remote')])
    await ensureLazyAttach('remote', ctx)
    expect(ctx.router.has('remote')).toBe(true)
  })

  it('does not re-attach or re-resolve a location already registered', async () => {
    const { ctx, resolve } = makeLazyCtx([constructable('remote')])
    await ensureLazyAttach('remote', ctx)
    const first = ctx.router.get('remote')
    resolve.mockClear()
    await ensureLazyAttach('remote', ctx)
    expect(resolve).not.toHaveBeenCalled()
    expect(ctx.router.get('remote')).toBe(first)
  })

  it('attempts an unreachable location at most once per session', async () => {
    const { ctx, resolve } = makeLazyCtx([constructable('remote')], {
      transportFactory: () => {
        throw new Error('boom')
      },
    })
    await ensureLazyAttach('remote', ctx)
    expect(ctx.router.has('remote')).toBe(false)
    resolve.mockClear()
    await ensureLazyAttach('remote', ctx)
    // The retained in-flight entry means a dead remote isn't retried (or
    // re-resolved) on every subsequent call.
    expect(resolve).not.toHaveBeenCalled()
  })

  it('attaches every candidate when target is undefined', async () => {
    const { ctx } = makeLazyCtx([constructable('alpha'), constructable('beta')])
    await ensureLazyAttach(undefined, ctx)
    expect(ctx.router.has('alpha')).toBe(true)
    expect(ctx.router.has('beta')).toBe(true)
  })

  it('skips the local location without resolving', async () => {
    const { ctx, resolve } = makeLazyCtx([])
    await ensureLazyAttach('local', ctx)
    expect(resolve).not.toHaveBeenCalled()
    expect(ctx.router.has('local')).toBe(false)
  })

  it('skips a location missing its Clerk pointer', async () => {
    const noClerk: ResolvedLocation = { ...constructable('remote'), clerkClientId: undefined }
    const { ctx } = makeLazyCtx([noClerk])
    await ensureLazyAttach('remote', ctx)
    expect(ctx.router.has('remote')).toBe(false)
  })

  it('attaches each location exactly once under concurrent overlapping calls', async () => {
    // Regression: a wide-net ensureLazyAttach(undefined) racing a targeted
    // ensureLazyAttach('beta') must not attach "beta" twice while the first
    // attach's introduce() is still in flight. With a plain attempted-Set the
    // wide-net caller re-checks only router.has() after resuming, so it
    // re-attaches a location a concurrent caller already started.
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
    // Persistent per-name gates: a second (erroneous) attach of the same
    // location awaits the SAME promise, so releasing it frees every attempt
    // and the double-attach surfaces as a failed assertion, not a hang.
    const release = new Map<string, () => void>()
    const gate = new Map<string, Promise<void>>()
    for (const n of ['alpha', 'beta']) {
      gate.set(n, new Promise<void>((resolve) => release.set(n, resolve)))
    }
    const factoryCalls: string[] = []
    const factory = vi.fn((loc: ResolvedLocation) => {
      factoryCalls.push(loc.name)
      const t = new FakeRemoteTransport(loc.name)
      t.introduce = vi.fn(async () => {
        await gate.get(loc.name)
      })
      return t
    })
    const { ctx } = makeLazyCtx([constructable('alpha'), constructable('beta')], { transportFactory: factory })

    const p1 = ensureLazyAttach(undefined, ctx) // wide-net: alpha, then beta
    await tick()
    const p2 = ensureLazyAttach('beta', ctx) // targeted: beta
    await tick()
    release.get('alpha')?.() // alpha completes; a sequential wide-net loop now re-attaches beta
    await tick()
    release.get('beta')?.()
    await Promise.all([p1, p2])

    expect(factoryCalls.filter((n) => n === 'beta')).toHaveLength(1)
    expect(ctx.router.has('beta')).toBe(true)
  })

  it('does not attach implicitly when the session has no name', async () => {
    // Before introduce, attachLocation would register the remote without a
    // validating introduce, which then trips the org-required gate on the
    // eventual introduce. Implicit (tool-triggered) attach must wait for a name.
    const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' })
    const { ctx, resolve } = makeLazyCtx([constructable('remote')], { session })
    await ensureLazyAttach('remote', ctx)
    expect(ctx.router.has('remote')).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('attaches with force even when the session has no name', async () => {
    // authenticate is an explicit sign-in; it opts in via force and does not
    // require a prior introduce.
    const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' })
    const { ctx } = makeLazyCtx([constructable('remote')], { session })
    await ensureLazyAttach('remote', ctx, { force: true })
    expect(ctx.router.has('remote')).toBe(true)
  })

  it('retries a non-constructable location after tokens are written', async () => {
    // A location skipped for missing tokens must not be permanently recorded
    // as a spent attempt — a peer process may persist tokens, and a later
    // re-resolve should pick them up.
    const noTokens: ResolvedLocation = { ...constructable('remote'), accessToken: undefined, refreshToken: undefined }
    let current: ResolvedLocation = noTokens
    const { ctx } = makeLazyCtx([noTokens], {
      resolve: () => ({
        locations: [current],
        activeLocation: undefined,
        activeChannel: undefined,
        activeTopic: undefined,
      }),
    })
    await ensureLazyAttach('remote', ctx)
    expect(ctx.router.has('remote')).toBe(false)

    current = constructable('remote') // peer wrote tokens
    await ensureLazyAttach('remote', ctx)
    expect(ctx.router.has('remote')).toBe(true)
  })

  it('force re-attempts a location after a prior failed attach', async () => {
    // The once-per-session guard must not condemn an explicit authenticate to
    // a full sign-in after a single transient failure.
    let failNext = true
    const factory = vi.fn((loc: ResolvedLocation) => {
      if (failNext) {
        failNext = false
        throw new Error('transient network blip')
      }
      return new FakeRemoteTransport(loc.name)
    })
    const { ctx } = makeLazyCtx([constructable('remote')], { transportFactory: factory })

    await ensureLazyAttach('remote', ctx) // fails; retained so implicit calls don't retry
    expect(ctx.router.has('remote')).toBe(false)
    await ensureLazyAttach('remote', ctx) // implicit: deduped, no retry
    expect(ctx.router.has('remote')).toBe(false)
    expect(factory).toHaveBeenCalledTimes(1)

    await ensureLazyAttach('remote', ctx, { force: true }) // explicit recovery
    expect(ctx.router.has('remote')).toBe(true)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
