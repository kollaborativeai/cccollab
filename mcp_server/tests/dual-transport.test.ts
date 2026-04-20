import { describe, it, expect, beforeEach, vi } from 'vitest'

import { ActiveContext } from '../src/context.js'
import { SessionManager } from '../src/session.js'
import { TransportRouter } from '../src/transport/router.js'
import { handleChannelTool } from '../src/tools/channels.js'
import { handleTopicTool } from '../src/tools/topics.js'
import { handleIdentityTool, type IdentityToolDeps } from '../src/tools/identity.js'
import type { ResolvedLocation } from '../src/config/resolve.js'
import {
  type Transport,
  type TransportChannel,
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
  readonly source: 'local' | 'remote'
  enabled = true
  private readonly topicIds = new Set<string>()
  private readonly channels = new Map<string, TransportChannel>()
  private readonly topics = new Map<string, TransportTopic>()
  private readonly sessions: TransportSession[] = []

  introduce = vi.fn(async (_args: { sessionName: string; objective?: string }) => {})
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
    async (_args: { sessionName?: string; channel?: string; includeArchived?: boolean }): Promise<TransportTopic[]> => {
      return [...this.topics.values()]
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
  sendDirectMessage = vi.fn(
    async (_args: {
      fromSessionName: string
      toSessionName: string
      text: string
    }): Promise<{ viaChannel?: string }> => {
      return {}
    },
  )
  deregisterSession = vi.fn(async (_args: { sessionName: string }) => {})

  constructor(source: 'local' | 'remote') {
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

  /** Pre-register a session for `listSessions` / DM routing tests. */
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

  it('whoami surfaces the remote degraded state', async () => {
    // Simulate a "configured but disabled" remote transport by passing
    // a FakeTransport whose enabled flag is off. The identity tool's
    // degradation reporter reads `.enabled` and `.degradation` off the
    // transport it finds at source="remote".
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
    expect(result.remote).toMatchObject({
      configured: true,
      enabled: false,
      degradation: expect.stringContaining('Remote sync disabled'),
    })
  })
})

describe('Dual transport: list_sessions merging', () => {
  it('unions channels from both transports, tagging each with its location', async () => {
    const local = new FakeTransport('local')
    const remote = new FakeTransport('remote')
    local.registerSession({
      name: 'alice',
      objective: 'Design API',
      channels: ['dev'],
      registeredAt: '2026-01-01T00:00:00Z',
    })
    remote.registerSession({
      name: 'alice',
      channels: ['cccollab'],
      registeredAt: '2026-01-01T00:00:00Z',
    })
    const deps = makeDeps([local, remote])
    deps.context.joinChannel('dev', 'manual', 'local')
    deps.context.joinChannel('cccollab', 'manual', 'remote')

    const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      name: 'alice',
      objective: 'Design API',
      channels: [
        { name: 'dev', location: 'local' },
        { name: 'cccollab', location: 'remote' },
      ],
    })
  })
})

// `runAuthenticate` is mocked so the "force: true" path exercises the
// wiring without running the real OAuth flow. The mock is hoisted to
// the top of the module by vitest; `identity.ts` imports the mocked
// symbol transparently.
vi.mock('../src/remote/auth.js', () => ({
  runAuthenticate: vi.fn(async () => ({
    locationName: 'remote',
    url: 'https://example.convex.cloud',
  })),
}))

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
 * post-sign-in attach path pass their own `messageBus` and
 * `remoteUnsubscribes`; tests that only care about the setup guidance
 * branch can skip them.
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
    remoteUnsubscribes?: IdentityToolDeps['remoteUnsubscribes']
    cwd?: string
    env?: NodeJS.ProcessEnv
  } = {},
): IdentityToolDeps {
  const deps = makeDeps(transports)
  const resolvedLocations: ResolvedLocation[] = locations.map((l) => ({
    name: l.name,
    isLocal: l.isLocal,
    url: l.url,
    channels: l.channels ?? [],
  }))
  return {
    ...deps,
    locations: resolvedLocations,
    messageBus: extras.messageBus,
    remoteUnsubscribes: extras.remoteUnsubscribes,
    cwd: extras.cwd ?? '/tmp/test',
    env: extras.env ?? {},
  }
}

/**
 * A remote transport fake that supports `subscribeDirectMessages` so
 * the hot-attach path can wire it into MessageBus. The base
 * FakeTransport class has no DM subscription hook because most of the
 * legacy dual-transport tests don't need one; we subclass rather than
 * bloat the base.
 */
class HotAttachRemote extends FakeTransport {
  subscribedDms: Array<(msg: import('../src/types.js').ParsedMessage) => void> = []
  dmUnsubscribed = false
  constructor(source: string) {
    super(source as 'local' | 'remote')
  }
  subscribeDirectMessages(onEvent: (msg: import('../src/types.js').ParsedMessage) => void): () => void {
    this.subscribedDms.push(onEvent)
    return () => {
      this.dmUnsubscribed = true
    }
  }
}

async function mockFreshResolve(
  locations: ResolvedLocation[],
  active: { activeLocation?: string; activeChannel?: { name: string; location: string } } = {},
): Promise<void> {
  const resolved = await import('../src/config/resolve.js')
  ;(resolved.resolveConfig as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    config: { locations: {} },
    active,
    projectFilePath: null,
    locations,
  }))
}

describe('authenticate tool', () => {
  beforeEach(async () => {
    const { runAuthenticate } = await import('../src/remote/auth.js')
    ;(runAuthenticate as unknown as ReturnType<typeof vi.fn>).mockClear()
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
    const { runAuthenticate } = await import('../src/remote/auth.js')
    expect(runAuthenticate).not.toHaveBeenCalled()
  })

  it('hot-attaches a new remote transport after force: true, replacing the old one', async () => {
    const local = new FakeTransport('local')
    const oldRemote = new HotAttachRemote('remote')
    const remoteUnsubscribes: Array<() => void> = []
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
      { messageBus: bus, remoteUnsubscribes },
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
    const { runAuthenticate } = await import('../src/remote/auth.js')
    expect(runAuthenticate).toHaveBeenCalledWith({
      locationName: 'remote',
      url: 'https://example.convex.cloud',
    })
    expect(result).toContain('Signed in')
    expect(result).toContain('is now active')
    expect(result).toContain('alice@example.com')

    // The old transport got torn down, the new one is live.
    expect(oldRemote.deregisterSession).toHaveBeenCalledWith({ sessionName: 'architect' })
    const live = deps.router.all().find((t) => t.source === 'remote')
    expect(live).toBe(newRemote)
    // DM subscription wired; unsubscribe is tracked for shutdown.
    expect(newRemote.subscribedDms.length).toBe(1)
    expect(remoteUnsubscribes.length).toBe(1)
  })

  it('hot-attach failure after sign-in keeps tokens persisted and returns restart guidance', async () => {
    const local = new FakeTransport('local')
    const remoteUnsubscribes: Array<() => void> = []
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
      { messageBus: bus, remoteUnsubscribes },
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
    // No orphan DM subscription was left behind.
    expect(remoteUnsubscribes.length).toBe(0)
  })

  it('errors when location arg names an unknown location', async () => {
    const local = new FakeTransport('local')
    const deps = makeDepsWithLocations([local], [{ name: 'local', isLocal: true }])
    const result = await handleIdentityTool('authenticate', { location: 'nope' }, deps)
    expect(result).toContain('No non-local location named "nope" is configured')
  })

  it('falls back to the restart message when hot-attach context is not provided', async () => {
    // No messageBus / remoteUnsubscribes passed -> identity.ts cannot
    // call attachLocation; it must surface the legacy "restart" message
    // instead of failing silently.
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
    const remoteUnsubscribes: Array<() => void> = []
    const bus = {
      push: vi.fn(async () => {}),
    } as unknown as IdentityToolDeps['messageBus']
    const deps = makeDepsWithLocations(
      [local],
      [
        { name: 'local', isLocal: true },
        { name: 'remote', isLocal: false, url: 'https://example.convex.cloud' },
      ],
      { messageBus: bus, remoteUnsubscribes },
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
