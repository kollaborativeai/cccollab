import { describe, it, expect, beforeEach, vi } from 'vitest'

import { ActiveContext } from '../src/context.js'
import { SessionManager } from '../src/session.js'
import { TransportRouter } from '../src/transport/router.js'
import { handleChannelTool } from '../src/tools/channels.js'
import { handleTopicTool } from '../src/tools/topics.js'
import { handleIdentityTool, type IdentityToolDeps } from '../src/tools/identity.js'
import { attachLocation } from '../src/transport/attach.js'
import { AttachDiagnostics } from '../src/transport/diagnostics.js'
import type { MessageBus } from '../src/message-bus.js'
import type { ResolvedLocation } from '../src/config/resolve.js'
import {
  type Transport,
  type TransportChannel,
  type TransportHistoryPage,
  type TransportSession,
  type TransportTopic,
  type TransportTopicMessage,
  BROKER_UUID_PATTERN,
} from '../src/transport/index.js'

/**
 * Minimal in-memory Transport implementation used by the integration
 * tests. Each method is a Vitest mock so we can assert who saw which
 * call. A FakeTransport is always "on" (enabled = true) unless a test
 * explicitly flips it.
 *
 * Topic ownership is controlled by the `topicIds` set - calling
 * `hasTopic(id)` returns true for ids registered there. This lets
 * tests exercise both the UUID-shaped local id path and Convex-shaped
 * remote ids without pulling in real broker / Convex infra.
 */
class FakeTransport implements Transport {
  readonly source: string
  enabled = true
  private readonly topicIds = new Set<string>()
  private readonly channels = new Map<string, TransportChannel>()
  private readonly topics = new Map<string, TransportTopic>()
  private readonly sessions: TransportSession[] = []

  introduce = vi.fn(async (_args: { sessionName: string; objective?: string; organizationId?: string }) => {})
  joinChannel = vi.fn(async (args: { sessionName: string; channel: string }) => {
    const existing = this.channels.get(args.channel) ?? { name: args.channel, subscriberCount: 0 }
    existing.subscriberCount += 1
    this.channels.set(args.channel, existing)
    return { subscriberCount: existing.subscriberCount }
  })
  leaveChannel = vi.fn(async (_args: { sessionName: string; channel: string }) => {})
  listChannels = vi.fn(async (_args: { sessionName?: string }): Promise<TransportChannel[]> => {
    return [...this.channels.values()]
  })
  broadcast = vi.fn(async (_args: { sessionName: string; channel: string; text: string }) => {})
  createTopic = vi.fn(
    async (args: { sessionName: string; channel: string; topic: string }): Promise<TransportTopic> => {
      const id = this.nextTopicId()
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
      // Honour the channel filter so this fake models production
      // behaviour (the remote transport's `listTopics` requires a
      // channel server-side; without filtering, a buggy caller that
      // forgets to pass `channel` would silently match any topic in
      // the test fixture).
      const all = [...this.topics.values()]
      if (args.channel === undefined) return all
      const want = args.channel.toLowerCase()
      return all.filter((t) => t.channel.toLowerCase() === want)
    },
  )
  getTopicById = vi.fn(async (args: { sessionName: string; topicId: string }): Promise<TransportTopic | null> => {
    return this.topics.get(args.topicId) ?? null
  })
  joinTopic = vi.fn(
    async (args: {
      sessionName: string
      topicId: string
    }): Promise<{ channel?: string; history: TransportTopicMessage[] }> => {
      return { channel: this.topics.get(args.topicId)?.channel, history: [] }
    },
  )
  leaveTopic = vi.fn(async (_args: { sessionName: string; topicId: string }) => {})
  archiveTopic = vi.fn(async (_args: { sessionName: string; topicId: string }) => {})
  unarchiveTopic = vi.fn(async (_args: { sessionName: string; topicId: string }) => {})
  sendTopicMessage = vi.fn(async (_args: { sessionName: string; topicId: string; text: string }) => {})
  listSessions = vi.fn(async (_args: { channel?: string }): Promise<TransportSession[]> => {
    return this.sessions
  })
  deregisterSession = vi.fn(async (_args: { sessionName: string }) => {})
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

  /** Pre-register a topic the test will hand to the tool layer by id. */
  registerTopic(t: TransportTopic): void {
    this.topics.set(t.id, t)
    this.topicIds.add(t.id)
  }

  /** Pre-register a session for `listSessions` tests. */
  registerSession(s: TransportSession): void {
    this.sessions.push(s)
  }

  /** Pre-register a channel for `listChannels` tests. */
  registerChannel(c: TransportChannel): void {
    this.channels.set(c.name, c)
  }

  private nextTopicId(): string {
    // Local fakes emit UUID-shaped ids; remote fakes emit Convex-shaped
    // ids that deliberately don't match BROKER_UUID_PATTERN so the
    // shape-based fallback in the router would still route correctly
    // even without the positive `topicIds` cache.
    if (this.source === 'local') {
      return `00000000-0000-4000-8000-${String(this.topics.size + 1).padStart(12, '0')}`
    }
    return `jabcdef${String(this.topics.size + 1).padStart(20, 'z')}`
  }
}

function makeDeps(transports: Transport[], sessionName = 'architect') {
  const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' })
  session.setName(sessionName)
  const context = new ActiveContext()
  const router = new TransportRouter(transports)
  return { session, context, router }
}

describe('Dual transport: channel routing', () => {
  let local: FakeTransport
  let remote: FakeTransport

  beforeEach(() => {
    local = new FakeTransport('local')
    remote = new FakeTransport('remote')
  })

  it('join_channel with location=local only calls local transport', async () => {
    const deps = makeDeps([local, remote])
    const result = JSON.parse(await handleChannelTool('join_channel', { name: 'dev', location: 'local' }, deps))
    expect(result).toMatchObject({ channel: 'dev', location: 'local' })
    expect(local.joinChannel).toHaveBeenCalledTimes(1)
    expect(remote.joinChannel).not.toHaveBeenCalled()
    expect(deps.context.isChannelSubscribed('dev', 'local')).toBe(true)
    expect(deps.context.isChannelSubscribed('dev', 'remote')).toBe(false)
  })

  it('join_channel with location=remote only calls remote transport', async () => {
    const deps = makeDeps([local, remote])
    const result = JSON.parse(await handleChannelTool('join_channel', { name: 'cccollab', location: 'remote' }, deps))
    expect(result).toMatchObject({ channel: 'cccollab', location: 'remote' })
    expect(remote.joinChannel).toHaveBeenCalledTimes(1)
    expect(local.joinChannel).not.toHaveBeenCalled()
  })

  it('send_message_to_channel honours the subscribed location', async () => {
    const deps = makeDeps([local, remote])
    deps.context.joinChannel('dev', 'manual', 'local')
    await handleChannelTool('send_message_to_channel', { text: 'hi', channel: 'dev' }, deps)
    expect(local.broadcast).toHaveBeenCalledWith({ sessionName: 'architect', channel: 'dev', text: 'hi' })
    expect(remote.broadcast).not.toHaveBeenCalled()
  })

  it('list_channels with no filter queries both transports and tags each row with its location', async () => {
    local.registerChannel({ name: 'dev', subscriberCount: 2 })
    remote.registerChannel({ name: 'cccollab', subscriberCount: 5 })
    const deps = makeDeps([local, remote])
    const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
    const byNameLoc = new Map(
      result.channels.map((c: { name: string; location: string }) => [`${c.location}::${c.name}`, c]),
    )
    expect(byNameLoc.get('local::dev')).toMatchObject({ location: 'local', subscriberCount: 2 })
    expect(byNameLoc.get('remote::cccollab')).toMatchObject({ location: 'remote', subscriberCount: 5 })
  })

  it('list_channels with location filter only queries that transport', async () => {
    local.registerChannel({ name: 'dev', subscriberCount: 1 })
    remote.registerChannel({ name: 'cccollab', subscriberCount: 1 })
    const deps = makeDeps([local, remote])
    const result = JSON.parse(await handleChannelTool('list_channels', { location: 'remote' }, deps))
    expect(result.channels).toHaveLength(1)
    expect(result.channels[0].location).toBe('remote')
    expect(local.listChannels).not.toHaveBeenCalled()
  })
})

describe('Dual transport: topic routing by id', () => {
  let local: FakeTransport
  let remote: FakeTransport
  const localUuid = '11111111-2222-3333-4444-555555555555'
  const remoteConvexId = 'jab9c1d4efghijklmnopqrstuvwx'

  beforeEach(() => {
    local = new FakeTransport('local')
    remote = new FakeTransport('remote')
    // Broker-shaped UUID → local fake; Convex-shaped id → remote fake.
    local.registerTopic({
      id: localUuid,
      topic: 'local-topic',
      channel: 'dev',
      creator: 'architect',
      state: 'active',
      createdAt: '2026-01-01T00:00:00Z',
    })
    remote.registerTopic({
      id: remoteConvexId,
      topic: 'remote-topic',
      channel: 'cccollab',
      creator: 'architect',
      state: 'active',
      createdAt: '2026-01-01T00:00:00Z',
    })
    // Sanity-check the id-shape invariant the RemoteTransport relies on.
    expect(BROKER_UUID_PATTERN.test(localUuid)).toBe(true)
    expect(BROKER_UUID_PATTERN.test(remoteConvexId)).toBe(false)
  })

  it('send_message_to_topic on a UUID topic goes local only', async () => {
    const deps = makeDeps([local, remote])
    deps.context.joinChannel('dev', 'manual', 'local')
    deps.context.joinTopic(localUuid, 'local-topic', 'dev', 'local')
    const result = JSON.parse(await handleTopicTool('send_message_to_topic', { text: 'ping' }, deps))
    expect(result).toEqual({ topicId: localUuid })
    expect(local.sendTopicMessage).toHaveBeenCalledWith({
      sessionName: 'architect',
      topicId: localUuid,
      text: 'ping',
    })
    expect(remote.sendTopicMessage).not.toHaveBeenCalled()
  })

  it('send_message_to_topic on a Convex-shaped id goes remote only', async () => {
    const deps = makeDeps([local, remote])
    deps.context.joinChannel('cccollab', 'manual', 'remote')
    deps.context.joinTopic(remoteConvexId, 'remote-topic', 'cccollab', 'remote')
    const result = JSON.parse(await handleTopicTool('send_message_to_topic', { text: 'pong' }, deps))
    expect(result).toEqual({ topicId: remoteConvexId })
    expect(remote.sendTopicMessage).toHaveBeenCalledWith({
      sessionName: 'architect',
      topicId: remoteConvexId,
      text: 'pong',
    })
    expect(local.sendTopicMessage).not.toHaveBeenCalled()
  })

  it('archive_topic routes by the stored location of the joined topic', async () => {
    const deps = makeDeps([local, remote])
    deps.context.joinChannel('cccollab', 'manual', 'remote')
    deps.context.joinTopic(remoteConvexId, 'remote-topic', 'cccollab', 'remote')
    await handleTopicTool('archive_topic', {}, deps)
    expect(remote.archiveTopic).toHaveBeenCalledTimes(1)
    expect(local.archiveTopic).not.toHaveBeenCalled()
  })

  it('join_topic by NAME finds a remote topic via per-channel fan-out', async () => {
    // Regression: listTopicsAcrossTransports used to call
    // transport.listTopics() with no channel arg. The remote
    // transport's listTopics short-circuits to [] without a channel,
    // so name-based join_topic against a remote topic silently failed.
    // The fix fans out per (transport, subscribed channel at that
    // location); this test asserts the fan-out happens.
    const deps = makeDeps([local, remote])
    deps.context.joinChannel('cccollab', 'manual', 'remote')
    const result = JSON.parse(await handleTopicTool('join_topic', { topic: 'remote-topic' }, deps))
    expect(result.id).toBe(remoteConvexId)
    expect(result.location).toBe('remote')
    expect(remote.joinTopic).toHaveBeenCalledWith({ sessionName: 'architect', topicId: remoteConvexId })
    expect(local.joinTopic).not.toHaveBeenCalled()
    // The remote fake's listTopics was invoked with the subscribed
    // channel name — the diagnostic that proves the fan-out happened.
    expect(remote.listTopics).toHaveBeenCalledWith(expect.objectContaining({ channel: 'cccollab' }))
  })
})

describe('Dual transport: graceful degradation', () => {
  it('with remote disabled, remote-location calls surface a degraded error; local continues to work', async () => {
    const local = new FakeTransport('local')
    const remote = new FakeTransport('remote')
    remote.enabled = false
    const deps = makeDeps([local, remote])

    // Remote-addressed call fails cleanly.
    const failure = JSON.parse(await handleChannelTool('join_channel', { name: 'cccollab', location: 'remote' }, deps))
    expect(failure.error).toMatch(/remote sync is degraded|Remote/i)
    expect(remote.joinChannel).not.toHaveBeenCalled()

    // Local still works.
    const success = JSON.parse(await handleChannelTool('join_channel', { name: 'dev', location: 'local' }, deps))
    expect(success).toMatchObject({ channel: 'dev', location: 'local' })
    expect(local.joinChannel).toHaveBeenCalledTimes(1)
  })

  it('whoami surfaces per-location degradation in the `locations` map', async () => {
    // Simulate a "configured but disabled" remote transport by passing
    // a FakeTransport whose enabled flag is off. The identity tool's
    // per-location map reads `.enabled` and `.degradation` off every
    // transport in the router, keyed by location name. The local
    // transport has no degradation surface and reports enabled: true.
    class DegradedRemote extends FakeTransport {
      degradation = 'Remote sync disabled: function not found on deployment (FakeReason)'
      constructor() {
        super('remote')
        this.enabled = false
      }
    }
    const local = new FakeTransport('local')
    const remote = new DegradedRemote()
    const deps = makeDeps([local, remote])
    await handleIdentityTool('introduce', { name: 'architect' }, deps)
    const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
    expect(result.locations).toMatchObject({
      local: { enabled: true },
      remote: {
        enabled: false,
        degradation: expect.stringContaining('Remote sync disabled'),
      },
    })
    // No `degradation` on local - the field is only set when present.
    expect(result.locations.local.degradation).toBeUndefined()
  })

  it('whoami always includes the reserved `local` location in the locations map', async () => {
    // Even without any non-local transport, `locations` contains `local`.
    const local = new FakeTransport('local')
    const deps = makeDeps([local])
    await handleIdentityTool('introduce', { name: 'architect' }, deps)
    const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
    expect(result.locations).toEqual({
      local: { enabled: true, organization: 'local' },
    })
  })
})

describe('Dual transport: list_sessions merging', () => {
  // Ids shaped the way each transport really issues them. The remote
  // backend mints Convex `Id<'cccollabSessions'>`; the local broker mints
  // none at all (`/sessions` GET reports name/objective/registeredAt/
  // channels only). Seeding a remote row *without* an id would be a state
  // production cannot reach — and it is the one state that still lands on
  // `mergeSessions`'s display-name fallback, which would merge the caller's
  // two rows for the wrong reason and hide a regression in the `self` key.
  const REMOTE_OWN_ID = 'k5711aaaaaaaaaaaaaaaaaaaaaaaaaa'
  const REMOTE_PEER_ID = 'k9922bbbbbbbbbbbbbbbbbbbbbbbbbb'

  /**
   * KAI-516's Expected Result, end to end at the tool layer: one process
   * that introduced itself on two transports is *one* session, and its
   * entry lists what it holds at each location.
   *
   * The fixture models what real transports emit — each one flags the row
   * that is its own registration, because each one holds the identity its
   * own `introduce` handed back. Nothing here keys off the display name;
   * that is not an identity (see the next test).
   */
  it('reports the caller once, unioning the channels it holds at each location', async () => {
    const local = new FakeTransport('local')
    const remote = new FakeTransport('remote')
    local.registerSession({
      name: 'architect',
      objective: 'Design API',
      channels: ['kai'],
      registeredAt: '2026-01-01T00:00:00Z',
      self: true,
    })
    remote.registerSession({
      id: REMOTE_OWN_ID,
      name: 'architect',
      channels: ['product'],
      registeredAt: '2026-01-01T00:00:00Z',
      self: true,
    })
    remote.registerSession({
      id: REMOTE_PEER_ID,
      name: 'reviewer',
      channels: [],
      registeredAt: '2026-01-01T00:00:00Z',
    })
    const deps = makeDeps([local, remote])
    deps.context.joinChannel('kai', 'manual', 'local')
    deps.context.joinChannel('product', 'manual', 'remote')

    const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps))
    expect(result.filter((s: { name: string }) => s.name === 'architect')).toHaveLength(1)
    expect(result[0]).toMatchObject({
      name: 'architect',
      objective: 'Design API',
      channels: [
        { name: 'kai', location: 'local' },
        { name: 'product', location: 'remote' },
      ],
    })
    expect(result).toHaveLength(2)
  })

  it("tags a peer's id with the location that issued it", async () => {
    // An id is only an address at the location that minted it — Convex
    // `_id`s are per deployment, broker uuids per broker, and neither
    // resolves anywhere else. Locations are named by the user's config,
    // so "remote" is one possible name and not a category the output can
    // assume.
    const remote = new FakeTransport('kai-prod')
    remote.registerSession({
      id: REMOTE_PEER_ID,
      name: 'reviewer',
      channels: [],
      registeredAt: '2026-01-01T00:00:00Z',
    })
    const deps = makeDeps([remote])
    deps.context.joinChannel('product', 'manual', 'kai-prod')

    const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: REMOTE_PEER_ID, location: 'kai-prod' })
  })

  it('tags the merged entry with the location that issued the id it kept', async () => {
    // Our own registrations collapse into one entry spanning every
    // location we attached to, but the entry carries a single id. Which
    // location that id came from is not derivable from the entry — the
    // channels span all of them and the local broker mints no id at all —
    // so the merge has to record it as the id is taken. Tagging it
    // afterwards, or on each merge, would name whichever transport was
    // merged last: an address handed to a location that never issued it.
    const local = new FakeTransport('local')
    const kai = new FakeTransport('kai-prod')
    const acme = new FakeTransport('acme-prod')
    local.registerSession({ name: 'architect', channels: ['kai'], registeredAt: '2026-01-01T00:00:00Z', self: true })
    kai.registerSession({
      id: REMOTE_OWN_ID,
      name: 'architect',
      channels: ['product'],
      registeredAt: '2026-01-01T00:00:00Z',
      self: true,
    })
    acme.registerSession({
      id: 'k3300cccccccccccccccccccccccccc',
      name: 'architect',
      channels: ['ops'],
      registeredAt: '2026-01-01T00:00:00Z',
      self: true,
    })
    const deps = makeDeps([local, kai, acme])
    deps.context.joinChannel('kai', 'manual', 'local')
    deps.context.joinChannel('product', 'manual', 'kai-prod')
    deps.context.joinChannel('ops', 'manual', 'acme-prod')

    const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: REMOTE_OWN_ID, location: 'kai-prod' })
  })

  it('omits location for a registration the transport reports without an id', async () => {
    // The local broker issues no id today. There is nothing to address,
    // so there is no address space to name either — an entry must not
    // carry a bare `location` that no `id` belongs to.
    const local = new FakeTransport('local')
    local.registerSession({ name: 'reviewer', channels: ['kai'], registeredAt: '2026-01-01T00:00:00Z' })
    const deps = makeDeps([local])
    deps.context.joinChannel('kai', 'manual', 'local')

    const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps))
    expect(result).toHaveLength(1)
    expect(Object.keys(result[0])).not.toContain('id')
    expect(Object.keys(result[0])).not.toContain('location')
  })

  it('keeps a peer that merely shares the caller’s display name separate', async () => {
    // Session names are unique per (user, organization) only, so two users
    // in one org can both run "architect". Merging on the name invents a
    // session that does not exist — and since KAI-516 fills the caller's
    // row in, it also hands that stranger the caller's real memberships.
    const local = new FakeTransport('local')
    const remote = new FakeTransport('remote')
    local.registerSession({
      name: 'architect',
      channels: ['kai'],
      registeredAt: '2026-01-01T00:00:00Z',
      self: true,
    })
    remote.registerSession({
      id: REMOTE_PEER_ID,
      name: 'architect',
      channels: [],
      registeredAt: '2026-01-02T00:00:00Z',
    })
    const deps = makeDeps([local, remote])
    deps.context.joinChannel('kai', 'manual', 'local')

    const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps))
    expect(result).toHaveLength(2)
    expect(result.map((s: { channels: unknown[] }) => s.channels)).toEqual([[{ name: 'kai', location: 'local' }], []])
  })
})

// `runClerkPkce` is mocked so the "force: true" path exercises the
// wiring without running the real PKCE flow. The mock is hoisted to
// the top of the module by vitest; `identity.ts` imports the mocked
// symbol transparently.
vi.mock('../src/remote/auth-clerk.js', () => ({
  runClerkPkce: vi.fn(async () => ({
    accessToken: 'jwt',
    refreshToken: 'refresh',
    idToken: 'id-jwt',
    accessTokenExpiresAt: Date.now() + 3_600_000,
  })),
}))

// `saveLocationAuth` writes to ~/.cccollab/config.json on the real disk.
// Mock it so the authenticate-tool tests don't touch the user's home dir.
vi.mock('../src/config/save.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config/save.js')>('../src/config/save.js')
  return {
    ...actual,
    saveLocationAuth: vi.fn(() => {}),
  }
})

// The hot-attach path re-resolves the config (via resolveConfig). Mock
// it so we can surface exactly the shape the test wants without
// writing to ~/.cccollab/config.json. The mock defaults to "no remote
// config" and individual tests override it with a more specific
// spyOn-style implementation where needed.
vi.mock('../src/config/resolve.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config/resolve.js')>('../src/config/resolve.js')
  return {
    ...actual,
    resolveConfig: vi.fn((cwd: string, _env: NodeJS.ProcessEnv) => {
      void cwd
      return {
        config: { locations: { local: {} } },
        active: {},
        projectFilePath: null,
        locations: [{ name: 'local', isLocal: true, channels: [] }],
      }
    }),
  }
})

/**
 * Build a hot-attach-ready deps bundle. Tests that exercise the
 * post-sign-in attach path pass their own `messageBus`; tests that only
 * care about the setup guidance branch can skip it.
 */
function makeDepsWithLocations(
  transports: Transport[],
  locations: Array<{
    name: string
    isLocal: boolean
    url?: string
    channels?: Array<{ name: string; topics: Array<{ name: string }> }>
  }>,
  extras: {
    messageBus?: IdentityToolDeps['messageBus']
    cwd?: string
    env?: NodeJS.ProcessEnv
  } = {},
): IdentityToolDeps {
  const deps = makeDeps(transports)
  const resolvedLocations: ResolvedLocation[] = locations.map((l) => ({
    name: l.name,
    isLocal: l.isLocal,
    url: l.url,
    // Non-local locations need a Clerk app pointer for handleAuthenticate
    // to dispatch to the Clerk flow. Inject defaults so per-test fixtures
    // stay terse.
    ...(l.isLocal ? {} : { authType: 'clerk' as const, clerkIssuer: 'iss', clerkClientId: 'cid' }),
    channels: l.channels ?? [],
  }))
  return {
    ...deps,
    locations: resolvedLocations,
    messageBus: extras.messageBus,
    cwd: extras.cwd ?? '/tmp/test',
    env: extras.env ?? {},
  }
}

/**
 * A remote transport fake used by the hot-attach path tests. The base
 * FakeTransport is stateless at the wire level, so this subclass adds a
 * real `shutdown()` to verify teardown on force-reauth.
 */
class HotAttachRemote extends FakeTransport {
  shutdownCalled = false
  shutdown = vi.fn(async (): Promise<void> => {
    this.shutdownCalled = true
    this.enabled = false
  })
  constructor(source: string) {
    super(source as 'local' | 'remote')
  }
}

async function mockFreshResolve(
  locations: ResolvedLocation[],
  active: { activeLocation?: string; activeChannel?: { name: string; location: string } } = {},
): Promise<void> {
  const resolved = await import('../src/config/resolve.js')
  const enriched = locations.map((l) =>
    l.isLocal ? l : { authType: 'clerk' as const, clerkIssuer: 'iss', clerkClientId: 'cid', ...l },
  )
  ;(resolved.resolveConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    config: { locations: {} },
    active,
    projectFilePath: null,
    locations: enriched,
  }))
}

describe('authenticate tool', () => {
  beforeEach(async () => {
    const { runClerkPkce } = await import('../src/remote/auth-clerk.js')
    ;(runClerkPkce as unknown as ReturnType<typeof vi.fn>).mockClear()
    // Reset resolveConfig mock to its default "nothing configured" value.
    const resolved = await import('../src/config/resolve.js')
    ;(resolved.resolveConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      config: { locations: { local: {} } },
      active: {},
      projectFilePath: null,
      locations: [{ name: 'local', isLocal: true, channels: [] }],
    }))
  })

  it('returns setup guidance when no non-local location is configured', async () => {
    const deps = makeDepsWithLocations([new FakeTransport('local')], [{ name: 'local', isLocal: true }])
    const result = await handleIdentityTool('authenticate', {}, deps)
    expect(result).toContain('Remote mode is not configured')
  })

  it('short-circuits when a non-local transport is already enabled and force is not set', async () => {
    // A remote transport is enabled in the router AND the config lists
    // its URL. The authenticate tool should short-circuit.
    const local = new FakeTransport('local')
    const remote = new FakeTransport('remote')
    const deps = makeDepsWithLocations(
      [local, remote],
      [
        { name: 'local', isLocal: true },
        { name: 'remote', isLocal: false, url: 'https://example.convex.cloud' },
      ],
    )
    const result = await handleIdentityTool('authenticate', {}, deps)
    expect(result).toContain('Already authenticated')
    expect(result).toContain('force')
    const { runClerkPkce } = await import('../src/remote/auth-clerk.js')
    expect(runClerkPkce).not.toHaveBeenCalled()
  })

  it('hot-attaches a new remote transport after force: true, replacing the old one', async () => {
    const local = new FakeTransport('local')
    const oldRemote = new HotAttachRemote('remote')
    const bus = {
      push: vi.fn(async () => {}),
    } as unknown as IdentityToolDeps['messageBus']

    const newRemote = new HotAttachRemote('remote')
    const factory = vi.fn(() => newRemote) as IdentityToolDeps['transportFactory']

    const deps = makeDepsWithLocations(
      [local, oldRemote],
      [
        { name: 'local', isLocal: true },
        { name: 'remote', isLocal: false, url: 'https://example.convex.cloud' },
      ],
      { messageBus: bus },
    )
    deps.transportFactory = factory

    await mockFreshResolve([
      { name: 'local', isLocal: true, channels: [] },
      {
        name: 'remote',
        isLocal: false,
        url: 'https://example.convex.cloud',
        accessToken: 'jwt',
        refreshToken: 'refresh',
        userEmail: 'alice@example.com',
        channels: [],
      },
    ])

    const result = await handleIdentityTool('authenticate', { force: true }, deps)
    const { runClerkPkce } = await import('../src/remote/auth-clerk.js')
    expect(runClerkPkce).toHaveBeenCalledWith({
      issuer: 'iss',
      clientId: 'cid',
      redirectPort: undefined,
    })
    expect(result).toContain('Signed in')
    expect(result).toContain('is now active')
    expect(result).toContain('alice@example.com')

    // The old transport got torn down, the new one is live.
    expect(oldRemote.deregisterSession).toHaveBeenCalledWith({ sessionName: 'architect' })
    const live = deps.router.all().find((t) => t.source === 'remote')
    expect(live).toBe(newRemote)
  })

  it('hot-attach on force: true tears down the old transport (shutdown, deregisterSession) before swapping', async () => {
    // Regression guard for the pre-fix leak: force-reauth used to leave
    // the old transport's ConvexClient websocket open. The new path must:
    //   1. Call `shutdown()` on the old transport.
    //   2. Call `deregisterSession` on the old transport.
    //   3. Swap the router to point at the new transport.
    const local = new FakeTransport('local')
    const oldRemote = new HotAttachRemote('remote')
    const bus = {
      push: vi.fn(async () => {}),
    } as unknown as IdentityToolDeps['messageBus']

    const newRemote = new HotAttachRemote('remote')
    const factory = vi.fn(() => newRemote) as IdentityToolDeps['transportFactory']

    const deps = makeDepsWithLocations(
      [local, oldRemote],
      [
        { name: 'local', isLocal: true },
        { name: 'remote', isLocal: false, url: 'https://example.convex.cloud' },
      ],
      { messageBus: bus },
    )
    deps.transportFactory = factory

    await mockFreshResolve([
      { name: 'local', isLocal: true, channels: [] },
      {
        name: 'remote',
        isLocal: false,
        url: 'https://example.convex.cloud',
        accessToken: 'jwt',
        refreshToken: 'refresh',
        channels: [],
      },
    ])

    const result = await handleIdentityTool('authenticate', { force: true }, deps)
    expect(result).toContain('is now active')

    // 1. Old shutdown called.
    expect(oldRemote.shutdown).toHaveBeenCalledTimes(1)
    expect(oldRemote.shutdownCalled).toBe(true)
    // 2. Old deregisterSession called.
    expect(oldRemote.deregisterSession).toHaveBeenCalledWith({ sessionName: 'architect' })
    // 3. Router now points at the new transport.
    expect(deps.router.all().find((t) => t.source === 'remote')).toBe(newRemote)
  })

  it('hot-attach failure after sign-in keeps tokens persisted and returns restart guidance', async () => {
    const local = new FakeTransport('local')
    const bus = {
      push: vi.fn(async () => {}),
    } as unknown as IdentityToolDeps['messageBus']

    const failingRemote = new HotAttachRemote('remote')
    failingRemote.introduce = vi.fn(async () => {
      throw new Error('backend rejected introduce')
    })
    const factory = vi.fn(() => failingRemote) as IdentityToolDeps['transportFactory']

    const deps = makeDepsWithLocations(
      [local],
      [
        { name: 'local', isLocal: true },
        { name: 'remote', isLocal: false, url: 'https://example.convex.cloud' },
      ],
      { messageBus: bus },
    )
    deps.transportFactory = factory

    await mockFreshResolve([
      { name: 'local', isLocal: true, channels: [] },
      {
        name: 'remote',
        isLocal: false,
        url: 'https://example.convex.cloud',
        accessToken: 'jwt',
        refreshToken: 'refresh',
        channels: [],
      },
    ])

    const result = await handleIdentityTool('authenticate', { location: 'remote' }, deps)

    // Sign-in succeeded; hot-attach did not. The user is told to
    // restart; the reason is surfaced so the failure isn't silent.
    expect(result).toContain('Signed in to "remote"')
    expect(result).toContain('could not attach')
    expect(result).toContain('Restart your Claude Code session')
    // The router must NOT contain the broken transport.
    expect(deps.router.has('remote')).toBe(false)
  })

  it('errors when location arg names an unknown location', async () => {
    const local = new FakeTransport('local')
    const deps = makeDepsWithLocations([local], [{ name: 'local', isLocal: true }])
    const result = await handleIdentityTool('authenticate', { location: 'nope' }, deps)
    expect(result).toContain('No non-local location named "nope" is configured')
  })

  it('falls back to the restart message when hot-attach context is not provided', async () => {
    // No messageBus passed -> identity.ts cannot call attachLocation; it
    // must surface the legacy "restart" message instead of failing
    // silently.
    const local = new FakeTransport('local')
    const deps = makeDepsWithLocations(
      [local],
      [
        { name: 'local', isLocal: true },
        { name: 'remote', isLocal: false, url: 'https://example.convex.cloud' },
      ],
    )
    const result = await handleIdentityTool('authenticate', { location: 'remote' }, deps)
    expect(result).toContain('Signed in')
    expect(result).toContain('Restart your Claude Code session')
  })

  it('returns a "could not locate saved tokens" message when the fresh resolve has no tokens', async () => {
    // Tokens are saved by runAuthenticate, but the mocked resolveConfig
    // doesn't surface them - simulates an edge case where the mkdir /
    // file write race or a malformed home dir puts saveLocationAuth's
    // write out of sight. The tool must not crash; it must keep the
    // tokens persisted and tell the user to restart.
    const local = new FakeTransport('local')
    const bus = {
      push: vi.fn(async () => {}),
    } as unknown as IdentityToolDeps['messageBus']
    const deps = makeDepsWithLocations(
      [local],
      [
        { name: 'local', isLocal: true },
        { name: 'remote', isLocal: false, url: 'https://example.convex.cloud' },
      ],
      { messageBus: bus },
    )
    // mockFreshResolve leaves token fields undefined
    await mockFreshResolve([
      { name: 'local', isLocal: true, channels: [] },
      { name: 'remote', isLocal: false, url: 'https://example.convex.cloud', channels: [] },
    ])

    const result = await handleIdentityTool('authenticate', { location: 'remote' }, deps)
    expect(result).toContain('could not locate the freshly-saved tokens')
    expect(result).toContain('Restart your Claude Code session')
  })
})

/**
 * Config-driven startup: given two locations + channels + topics in the
 * resolved config, the server auto-subscribes to everything and applies
 * the cascaded active state. This exercises the startup flow in
 * `server.ts` at the unit level by simulating the auto-subscribe loop
 * against two FakeTransports. A full end-to-end harness would spawn the
 * broker; this keeps the test fast and deterministic.
 */
describe('Dual transport: config-driven startup', () => {
  it('auto-subscribes to every channel and topic across both locations', async () => {
    const local = new FakeTransport('local')
    const remote = new FakeTransport('remote')

    // Pre-register a topic on each side so the "joinTopic on existing"
    // branch fires; another new topic name that doesn't exist triggers
    // createTopic.
    local.registerTopic({
      id: '00000000-0000-4000-8000-000000000001',
      topic: 'existing-local',
      channel: 'dev',
      creator: 'architect',
      state: 'active',
      createdAt: '2026-01-01T00:00:00Z',
    })

    const context = new ActiveContext()
    const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' })
    session.setName('architect')
    const router = new TransportRouter([local, remote])

    // Simulate resolve.ts' output.
    const resolvedLocations = [
      {
        name: 'local',
        isLocal: true,
        channels: [
          {
            name: 'dev',
            topics: [{ name: 'existing-local' }, { name: 'brand-new-local' }],
          },
        ],
      },
      {
        name: 'remote',
        isLocal: false,
        url: 'https://example.convex.cloud',
        channels: [
          {
            name: 'cccollab',
            topics: [{ name: 'brand-new-remote' }],
          },
        ],
      },
    ]

    // Replicate the auto-subscribe loop that server.ts runs.
    for (const location of resolvedLocations) {
      const transport = router.all().find((t) => t.source === location.name)
      if (!transport || !transport.enabled) continue
      for (const channel of location.channels) {
        await transport.joinChannel({ sessionName: session.displayName, channel: channel.name })
        context.joinChannel(channel.name, 'cccollab.json', location.name)
        const existing = await transport.listTopics({
          sessionName: session.displayName,
          channel: channel.name,
          includeArchived: false,
        })
        for (const topic of channel.topics) {
          const found = existing.find((t) => t.topic.toLowerCase() === topic.name.toLowerCase())
          if (found) {
            await transport.joinTopic({ sessionName: session.displayName, topicId: found.id })
            context.joinTopic(found.id, topic.name, channel.name, location.name)
          } else {
            const created = await transport.createTopic({
              sessionName: session.displayName,
              channel: channel.name,
              topic: topic.name,
            })
            context.joinTopic(created.id, topic.name, channel.name, location.name)
          }
        }
      }
    }

    // Every location's joinChannel fired once.
    expect(local.joinChannel).toHaveBeenCalledWith({ sessionName: 'architect', channel: 'dev' })
    expect(remote.joinChannel).toHaveBeenCalledWith({ sessionName: 'architect', channel: 'cccollab' })

    // Existing topic used joinTopic; new topic used createTopic.
    expect(local.joinTopic).toHaveBeenCalledTimes(1)
    expect(local.createTopic).toHaveBeenCalledTimes(1) // brand-new-local
    expect(remote.createTopic).toHaveBeenCalledTimes(1) // brand-new-remote

    // Context reflects both channel subscriptions tagged by location.
    expect(context.isChannelSubscribed('dev', 'local')).toBe(true)
    expect(context.isChannelSubscribed('cccollab', 'remote')).toBe(true)

    // The last joined topic becomes active.
    expect(context.hasTopic()).toBe(true)
  })
})

/**
 * KAI-368: a remote location whose `introduce` errors at startup must NOT
 * brick the plugin. The failed transport is never registered in the
 * router (so local + other transports keep working), it is torn down (no
 * leaked ConvexClient websocket), and the failure is recorded in the
 * diagnostics registry so `whoami` still surfaces it as ✗ degraded.
 */
describe('KAI-368: a failing remote attach does not brick local', () => {
  it('keeps local healthy, tears down the bad remote, and surfaces it as degraded in whoami', async () => {
    const local = new FakeTransport('local')
    const context = new ActiveContext()
    const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' })
    session.setName('architect')
    // The router starts with ONLY the local transport — exactly as
    // server.ts builds it before attaching non-local locations.
    const router = new TransportRouter([local])
    const diagnostics = new AttachDiagnostics()

    const busPushes: unknown[] = []
    const bus = { push: vi.fn(async (m: unknown) => void busPushes.push(m)) } as unknown as MessageBus

    // A remote whose introduce throws a prod-style "Server Error", and
    // whose shutdown we can observe was called (leak guard).
    const shutdown = vi.fn(async () => {})
    const failingRemote = {
      source: 'personal',
      enabled: true,
      introduce: vi.fn(async () => {
        throw new Error('Server Error')
      }),
      shutdown,
      joinChannel: vi.fn(async () => ({ subscriberCount: 0 })),
      deregisterSession: vi.fn(async () => {}),
      hasTopic: () => false,
    } as unknown as import('../src/transport/index.js').Transport

    const personal: ResolvedLocation = {
      name: 'personal',
      isLocal: false,
      url: 'https://personal.convex.cloud',
      accessToken: 'a',
      refreshToken: 'r',
      channels: [],
    }

    const result = await attachLocation('personal', {
      session,
      context,
      router,
      messageBus: bus,
      remoteTopicUnsubscribes: new Map(),
      remoteChannelUnsubscribes: new Map(),
      resolved: { locations: [personal], activeLocation: undefined, activeChannel: undefined, activeTopic: undefined },
      transportFactory: () => failingRemote,
      diagnostics,
    })

    // 1. The attach failed but did NOT throw — startup continues.
    expect(result.ok).toBe(false)
    // 2. The bad remote never entered the router; local is untouched.
    expect(router.has('personal')).toBe(false)
    expect(router.get('local').enabled).toBe(true)
    // 3. The orphaned transport was torn down (no leaked websocket).
    expect(shutdown).toHaveBeenCalledTimes(1)
    // 4. whoami surfaces local as healthy and personal as ✗ degraded,
    //    sourced from the diagnostics registry.
    const deps: IdentityToolDeps = { session, context, router, diagnostics }
    const who = JSON.parse(await handleIdentityTool('whoami', {}, deps))
    expect(who.locations.local).toEqual({ enabled: true, organization: 'local' })
    expect(who.locations.personal.enabled).toBe(false)
    expect(who.locations.personal.degradation).toContain('Server Error')
  })
})

/**
 * Regression: when the user only has a single non-`local`, non-`remote`
 * location configured (e.g. `"flatout"`), `send_message_to_channel`
 * without an explicit `location` must successfully route the message.
 * The old `ActiveContext.getChannelLocation` hardcoded checks for
 * `"local"` / `"remote"` and returned `undefined` for any other name,
 * so the tool falsely claimed the user wasn't subscribed.
 */
describe('Dual transport: arbitrary location name routing', () => {
  it('send_message_to_channel without explicit location succeeds when subscribed at an arbitrary location', async () => {
    const flatout = new FakeTransport('flatout')
    const deps = makeDeps([flatout])
    // User is subscribed to "dev" at "flatout" (e.g. via cccollab.json
    // auto-subscribe). No active channel is set yet, and the caller
    // provides `channel: "dev"` without `location`.
    deps.context.joinChannel('dev', 'cccollab.json', 'flatout')

    const result = JSON.parse(await handleChannelTool('send_message_to_channel', { text: 'hi', channel: 'dev' }, deps))
    expect(result).toEqual({ channel: 'dev', location: 'flatout' })
    expect(flatout.broadcast).toHaveBeenCalledWith({ sessionName: 'architect', channel: 'dev', text: 'hi' })
  })

  it('start_topic without explicit location uses the arbitrary location subscription', async () => {
    const flatout = new FakeTransport('flatout')
    const deps = makeDeps([flatout])
    deps.context.joinChannel('dev', 'cccollab.json', 'flatout')

    const result = JSON.parse(await handleTopicTool('start_topic', { topic: 'planning', channel: 'dev' }, deps))
    expect(result.id).toBeDefined()
    expect(result.channel).toBe('dev')
    expect(result.location).toBe('flatout')
    expect(flatout.createTopic).toHaveBeenCalled()
  })
})
