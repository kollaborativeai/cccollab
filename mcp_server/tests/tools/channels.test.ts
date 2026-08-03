import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleChannelTool, type ChannelToolDeps } from '../../src/tools/channels.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'
import { LocalTransport } from '../../src/transport/local.js'
import { TransportRouter } from '../../src/transport/router.js'
import { ensureLazyAttach } from '../../src/transport/attach.js'
import type { MessageBus } from '../../src/message-bus.js'
import type { Transport } from '../../src/transport/index.js'
import type { ResolvedLocation } from '../../src/config/resolve.js'

function createDeps(): ChannelToolDeps {
  const context = new ActiveContext()
  const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
  session.setName('architect')
  // Local-only router. Wraps `fetch(http://127.0.0.1:7850/...)`. Tests
  // mock `global.fetch` and assert URLs / bodies. Remote-transport
  // cases are covered in the dual-transport integration tests.
  const transport = new LocalTransport(7850)
  return { session, context, router: new TransportRouter([transport]), locations: [LOCAL] }
}

const LOCAL = { name: 'local', isLocal: true }

/** Deps whose config knows a non-local location. `attached` controls whether it
 *  also made it into the router: a dormant remote (the state a fresh
 *  orchestrator is in) is configured but absent from `router.enabled()`. */
function createRemoteDeps(opts: { attached?: boolean; subscriberCount?: number } = {}): ChannelToolDeps {
  const { attached = true, subscriberCount = 1 } = opts
  const remote = {
    source: 'flatout',
    enabled: true,
    hasTopic: () => false,
    introduce: async () => {},
    joinChannel: async () => ({ subscriberCount }),
    leaveChannel: async () => {},
    listChannels: async () => [],
    broadcast: async () => {},
    createTopic: async () => {
      throw new Error('not implemented')
    },
    listTopics: async () => [],
    getTopicById: async () => null,
    joinTopic: async () => ({ history: [] }),
    leaveTopic: async () => {},
    archiveTopic: async () => {},
    unarchiveTopic: async () => {},
    sendTopicMessage: async () => {},
    listSessions: async () => [],
    deregisterSession: async () => {},
  } as unknown as Transport
  const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
  session.setName('orchestrator')
  const transports = attached ? [new LocalTransport(7850), remote] : [new LocalTransport(7850)]
  return {
    session,
    context: new ActiveContext(),
    router: new TransportRouter(transports),
    locations: [LOCAL, { name: 'flatout', isLocal: false }],
  }
}

describe('Channel Tools', () => {
  describe('requires name', () => {
    it('rejects when session has no name', async () => {
      const deps = createDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const noName = { ...deps, session }
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'x' }, noName))
      expect(result.error).toContain('No name set')
    })

    it('allows list_channels without name', async () => {
      const deps = createDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      depsNoName.context.joinChannel('default', 'fallback', 'local')
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ channels: [{ name: 'default', subscriberCount: 1 }] }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleChannelTool('list_channels', {}, depsNoName))
      expect(result).toEqual({
        activeChannel: { name: 'default', location: 'local' },
        channels: [
          {
            name: 'default',
            location: 'local',
            source: 'fallback',
            subscriberCount: 1,
            subscribed: true,
            isActive: true,
            watching: false,
          },
        ],
      })
      vi.unstubAllGlobals()
    })
  })

  describe('join_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts to broker and updates context', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscriberCount: 1 }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'Project_X' }, deps))
      expect(result).toEqual({
        channel: 'project_x',
        location: 'local',
        becameActive: true,
        subscriberCount: 1,
        watching: false,
      })
      expect(deps.context.isChannelSubscribed('project_x', 'local')).toBe(true)
      expect(deps.context.getActiveChannel()).toBe('project_x')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('project_x')
      expect(body.sessionId).toBe('architect')
    })

    it('does not change active channel when already have one', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscriberCount: 2 }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'project_x' }, deps))
      expect(result.becameActive).toBe(false)
      expect(deps.context.getActiveChannel()).toBe('default')
    })

    it('rejects empty name', async () => {
      const result = JSON.parse(await handleChannelTool('join_channel', { name: '   ' }, deps))
      expect(result.error).toContain('non-empty')
    })
  })

  describe('list_channels reports watch mode (KAI-414)', () => {
    it('marks which subscribed channels are watched', async () => {
      const deps = createDeps()
      deps.context.joinChannel('kai', 'manual', 'local', true)
      deps.context.joinChannel('quiet', 'manual', 'local')
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              channels: [
                { name: 'kai', subscriberCount: 2 },
                { name: 'quiet', subscriberCount: 1 },
              ],
            }),
        }),
      )
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      const byName = Object.fromEntries(
        (result.channels as Array<{ name: string; watching: boolean }>).map((c) => [c.name, c.watching]),
      )
      expect(byName).toEqual({ kai: true, quiet: false })
      vi.unstubAllGlobals()
    })
  })

  describe('join_channel watch mode (KAI-414)', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscriberCount: 1 }) }),
      )
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('defaults to not watching, and says so', async () => {
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'kai' }, deps))
      expect(result.watching).toBe(false)
      expect(deps.context.isChannelWatched('kai', 'local')).toBe(false)
    })

    it('watch: true subscribes the session to channel-wide topic traffic', async () => {
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'kai', watch: true }, deps))
      expect(result.watching).toBe(true)
      expect(deps.context.isChannelWatched('kai', 'local')).toBe(true)
    })

    it('a plain re-join does not silently un-watch the channel', async () => {
      await handleChannelTool('join_channel', { name: 'kai', watch: true }, deps)
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'kai' }, deps))
      expect(result.watching).toBe(true)
      expect(deps.context.isChannelWatched('kai', 'local')).toBe(true)
    })

    it('watch: false turns watching back off', async () => {
      await handleChannelTool('join_channel', { name: 'kai', watch: true }, deps)
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'kai', watch: false }, deps))
      expect(result.watching).toBe(false)
      expect(deps.context.isChannelWatched('kai', 'local')).toBe(false)
    })

    it('fails loudly on a non-local location instead of half-working', async () => {
      const remoteDeps = createRemoteDeps()

      const result = JSON.parse(
        await handleChannelTool('join_channel', { name: 'kai', location: 'flatout', watch: true }, remoteDeps),
      )
      expect(result.error).toMatch(/local/i)
      expect(result.error).toContain('KAI-425')
      // The failed watch must not leave a half-subscribed channel behind.
      expect(remoteDeps.context.isChannelWatched('kai', 'flatout')).toBe(false)
    })

    // `location` defaults to 'local' and join_channel implicitly CREATES
    // channels. So an orchestrator whose fleet lives on a remote location that
    // calls join_channel({name, watch: true}) without a location would get a
    // brand-new, empty LOCAL channel, a success response, and watching: true —
    // then sit in an empty room receiving nothing while whoami cheerfully
    // reports it is watching. That is the exact "confidently blind" failure
    // this ticket exists to eliminate, so it must be refused, not defaulted.
    it('refuses a defaulted-location watch when remote locations exist, instead of watching an empty local channel', async () => {
      const ambiguous = createRemoteDeps()

      // No `location` passed — the dangerous case.
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'kai', watch: true }, ambiguous))
      expect(result.error).toMatch(/location/i)
      expect(ambiguous.context.isChannelSubscribed('kai', 'local')).toBe(false)
      expect(ambiguous.context.isChannelWatched('kai', 'local')).toBe(false)
    })

    // A fresh orchestrator's remotes have not attached yet, so the router does
    // not know them. The guard must read the CONFIGURED locations, or the exact
    // session this feature is for is the one that slips through it.
    it('refuses a defaulted-location watch when the only remote is configured but dormant', async () => {
      const dormant = createRemoteDeps({ attached: false })
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'kai', watch: true }, dormant))
      expect(result.error).toMatch(/location/i)
      expect(result.error).toContain('flatout')
      expect(dormant.context.isChannelSubscribed('kai', 'local')).toBe(false)
    })

    it('allows a defaulted-location watch when only the local transport exists', async () => {
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'kai', watch: true }, deps))
      expect(result.error).toBeUndefined()
      expect(result.watching).toBe(true)
    })

    it('allows an explicit local watch even when remote locations exist', async () => {
      const explicit = createRemoteDeps()

      const result = JSON.parse(
        await handleChannelTool('join_channel', { name: 'kai', location: 'local', watch: true }, explicit),
      )
      expect(result.error).toBeUndefined()
      expect(result.watching).toBe(true)
    })

    it('still allows a plain (unwatched) join on a non-local location', async () => {
      const remoteDeps = createRemoteDeps({ subscriberCount: 3 })

      const result = JSON.parse(
        await handleChannelTool('join_channel', { name: 'kai', location: 'flatout' }, remoteDeps),
      )
      expect(result.error).toBeUndefined()
      expect(result.watching).toBe(false)
      expect(remoteDeps.context.isChannelSubscribed('kai', 'flatout')).toBe(true)
    })
  })

  describe('leave_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('leaves a subscribed channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')
      deps.context.joinChannel('project_x', 'manual', 'local')
      const result = JSON.parse(await handleChannelTool('leave_channel', { name: 'default' }, deps))
      expect(result).toEqual({
        channel: 'default',
        location: 'local',
        removed: true,
        newActiveChannel: { name: 'project_x', location: 'local' },
      })
      expect(deps.context.isChannelSubscribed('default', 'local')).toBe(false)
      expect(deps.context.getActiveChannel()).toBe('project_x')
    })

    it('leaves only channel clears active', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')
      const result = JSON.parse(await handleChannelTool('leave_channel', { name: 'default' }, deps))
      expect(result.newActiveChannel).toBeNull()
      expect(deps.context.getActiveChannel()).toBeUndefined()
    })

    it('errors when not subscribed', async () => {
      const result = JSON.parse(await handleChannelTool('leave_channel', { name: 'nope' }, deps))
      expect(result.error).toContain('Not subscribed')
    })
  })

  describe('set_active_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })

    it('sets active channel when subscribed', async () => {
      deps.context.joinChannel('default', 'fallback', 'local')
      deps.context.joinChannel('project_x', 'manual', 'local')
      const result = JSON.parse(await handleChannelTool('set_active_channel', { name: 'project_x' }, deps))
      expect(result).toEqual({ activeChannel: { name: 'project_x', location: 'local' } })
      expect(deps.context.getActiveChannel()).toBe('project_x')
    })

    it('friendly error when not subscribed', async () => {
      const result = JSON.parse(await handleChannelTool('set_active_channel', { name: 'nope' }, deps))
      expect(result.error).toContain('Not subscribed')
      expect(result.error).toContain('join_channel')
    })
  })

  describe('list_channels', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('returns empty channels array with null activeChannel when none subscribed and broker sees none', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ channels: [] }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result).toEqual({ activeChannel: null, channels: [] })
    })

    it('marks the active channel, shows source and location, and hoists activeChannel to the top level', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            channels: [
              { name: 'default', subscriberCount: 3 },
              { name: 'project_x', subscriberCount: 2 },
            ],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')
      deps.context.joinChannel('project_x', 'manual', 'local')
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result).toEqual({
        activeChannel: { name: 'default', location: 'local' },
        channels: [
          {
            name: 'default',
            location: 'local',
            source: 'fallback',
            subscriberCount: 3,
            subscribed: true,
            isActive: true,
            watching: false,
          },
          {
            name: 'project_x',
            location: 'local',
            source: 'manual',
            subscriberCount: 2,
            subscribed: true,
            isActive: false,
            watching: false,
          },
        ],
      })
    })

    it('queries the broker global view without a sessionId', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ channels: [] }) })
      vi.stubGlobal('fetch', mockFetch)
      await handleChannelTool('list_channels', {}, deps)
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain('/channels')
      expect(url).not.toContain('sessionId')
    })

    it('includes broker channels the session has not joined with subscribed:false and source:null', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            channels: [
              { name: 'cccollab', subscriberCount: 1 },
              { name: 'acme-ai', subscriberCount: 3 },
            ],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('cccollab', 'cccollab.json', 'local')
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result).toEqual({
        activeChannel: { name: 'cccollab', location: 'local' },
        channels: [
          {
            name: 'cccollab',
            location: 'local',
            source: 'cccollab.json',
            subscriberCount: 1,
            subscribed: true,
            isActive: true,
            watching: false,
          },
          {
            name: 'acme-ai',
            location: 'local',
            source: null,
            subscriberCount: 3,
            subscribed: false,
            isActive: false,
            watching: false,
          },
        ],
      })
    })

    it('returns null activeChannel when no active channel is set', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            channels: [{ name: 'broadcast', subscriberCount: 5 }],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result.activeChannel).toBeNull()
      expect(result.channels).toEqual([
        {
          name: 'broadcast',
          location: 'local',
          source: null,
          subscriberCount: 5,
          subscribed: false,
          isActive: false,
          watching: false,
        },
      ])
    })

    it('still lists a locally-subscribed channel the broker did not report (fallback subscriberCount 1)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            channels: [{ name: 'other', subscriberCount: 4 }],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('local_only', 'manual', 'local')
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result.activeChannel).toEqual({ name: 'local_only', location: 'local' })
      expect(result.channels).toContainEqual({
        name: 'local_only',
        location: 'local',
        source: 'manual',
        subscriberCount: 1,
        sessionCount: 1,
        subscribed: true,
        isActive: true,
        watching: false,
      })
      expect(result.channels).toContainEqual({
        name: 'other',
        location: 'local',
        source: null,
        subscriberCount: 4,
        subscribed: false,
        isActive: false,
        watching: false,
      })
    })

    it('list_channels surfaces messageCount and sessionCount from the transport', async () => {
      const stubTransport = {
        source: 'local',
        enabled: true,
        hasTopic: () => false,
        introduce: async () => {},
        joinChannel: async () => ({ subscriberCount: 1 }),
        leaveChannel: async () => {},
        listChannels: async () => [{ name: 'dev', subscriberCount: 2, sessionCount: 5, messageCount: 7 }],
        broadcast: async () => {},
        createTopic: async () => {
          throw new Error('not implemented')
        },
        listTopics: async () => [],
        getTopicById: async () => null,
        joinTopic: async () => ({ history: [] }),
        leaveTopic: async () => {},
        archiveTopic: async () => {},
        unarchiveTopic: async () => {},
        sendTopicMessage: async () => {},
        listSessions: async () => [],
        deregisterSession: async () => {},
      }
      const context = new ActiveContext()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const stubDeps: ChannelToolDeps = {
        session,
        context,
        router: new TransportRouter([stubTransport as unknown as import('../../src/transport/index.js').Transport]),
        locations: [LOCAL],
      }
      const result = JSON.parse(await handleChannelTool('list_channels', {}, stubDeps))
      expect(result.channels[0].messageCount).toBe(7)
      expect(result.channels[0].subscriberCount).toBe(2)
      expect(result.channels[0].sessionCount).toBe(5)
    })

    it('lazily attaches a dormant token-bearing remote so its channels appear without authenticate', async () => {
      // The remote is valid in config but startup gating left it dormant
      // (not in the router). list_channels must bring it online and union
      // its channels — no `authenticate` round-trip required.
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const context = new ActiveContext()
      const router = new TransportRouter([new LocalTransport(7850)])
      const bus = { push: vi.fn(async () => {}) } as unknown as MessageBus
      const fakeRemote = {
        source: 'remote',
        enabled: true,
        introduce: vi.fn(async () => {}),
        listChannels: vi.fn(async () => [{ name: 'shared', subscriberCount: 3 }]),
      } as unknown as Transport
      const dormant: ResolvedLocation = {
        name: 'remote',
        isLocal: false,
        url: 'https://example.convex.cloud',
        accessToken: 'a',
        refreshToken: 'r',
        idToken: 'i',
        clerkIssuer: 'https://x.clerk.accounts.dev',
        clerkClientId: 'cid',
        channels: [],
      }
      const lazyDeps: ChannelToolDeps = {
        session,
        context,
        router,
        locations: [LOCAL, dormant],
        ensureAttached: (target?: string) =>
          ensureLazyAttach(target, {
            session,
            context,
            router,
            messageBus: bus,
            remoteTopicUnsubscribes: new Map(),
            remoteChannelUnsubscribes: new Map(),
            inflight: new Map<string, Promise<void>>(),
            candidates: ['remote'],
            resolve: () => ({
              locations: [dormant],
              activeLocation: undefined,
              activeChannel: undefined,
              activeTopic: undefined,
            }),
            transportFactory: () => fakeRemote,
          }),
      }

      const result = JSON.parse(await handleChannelTool('list_channels', {}, lazyDeps))
      expect(router.has('remote')).toBe(true)
      expect(
        result.channels.some((c: { name: string; location: string }) => c.name === 'shared' && c.location === 'remote'),
      ).toBe(true)
    })

    it('degrades gracefully when broker is unreachable and returns subscribed-only entries', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')
      deps.context.joinChannel('project_x', 'manual', 'local')
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result).toEqual({
        activeChannel: { name: 'default', location: 'local' },
        channels: [
          {
            name: 'default',
            location: 'local',
            source: 'fallback',
            subscriberCount: 1,
            sessionCount: 1,
            subscribed: true,
            isActive: true,
            watching: false,
          },
          {
            name: 'project_x',
            location: 'local',
            source: 'manual',
            subscriberCount: 1,
            sessionCount: 1,
            subscribed: true,
            isActive: false,
            watching: false,
          },
        ],
      })
    })
  })

  describe('read_channel_messages', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('returns paged channel history from the transport', async () => {
      const page = {
        messages: [{ sender: 'peer', senderSessionName: 'peer', text: 'hi', ts: 1_767_225_600_000 }],
        hasMore: false,
        oldestTs: 1_767_225_600_000,
      }
      const stubTransport = {
        source: 'local',
        enabled: true,
        hasTopic: () => false,
        introduce: async () => {},
        joinChannel: async () => ({ subscriberCount: 1 }),
        leaveChannel: async () => {},
        listChannels: async () => [],
        broadcast: async () => {},
        createTopic: async () => {
          throw new Error('not implemented')
        },
        listTopics: async () => [],
        getTopicById: async () => null,
        joinTopic: async () => ({ history: [] }),
        leaveTopic: async () => {},
        archiveTopic: async () => {},
        unarchiveTopic: async () => {},
        sendTopicMessage: async () => {},
        listSessions: async () => [],
        deregisterSession: async () => {},
        readChannelMessages: vi.fn().mockResolvedValue(page),
        readTopicMessages: async () => ({ messages: [], hasMore: false }),
      }
      const context = new ActiveContext()
      context.joinChannel('dev', 'manual', 'local')
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const stubDeps: ChannelToolDeps = {
        session,
        context,
        router: new TransportRouter([stubTransport as unknown as import('../../src/transport/index.js').Transport]),
        locations: [LOCAL],
      }
      const result = JSON.parse(await handleChannelTool('read_channel_messages', { channel: 'dev' }, stubDeps))
      expect(result.messages[0].text).toBe('hi')
      expect(result.hasMore).toBe(false)
    })

    it('surfaces a "not supported" error on the local transport instead of a silent empty page', async () => {
      const deps = createDeps()
      deps.context.joinChannel('dev', 'manual', 'local')
      // The tool layer lets the transport error propagate; server.ts turns it
      // into an MCP error result. Regression guard for KAI-371.
      await expect(handleChannelTool('read_channel_messages', { channel: 'dev' }, deps)).rejects.toThrow(
        /not available on the local transport/i,
      )
    })
  })

  describe('send_message_to_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts to active channel when no channel arg', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')
      const result = JSON.parse(await handleChannelTool('send_message_to_channel', { text: 'hi' }, deps))
      expect(result).toEqual({ channel: 'default', location: 'local' })
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('default')
      expect(body.text).toBe('hi')
    })

    it('posts to explicit channel when provided and subscribed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')
      deps.context.joinChannel('project_x', 'manual', 'local')
      const result = JSON.parse(
        await handleChannelTool('send_message_to_channel', { text: 'hi', channel: 'project_x' }, deps),
      )
      expect(result).toEqual({ channel: 'project_x', location: 'local' })
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('project_x')
    })

    it('errors when not subscribed to the target channel', async () => {
      deps.context.joinChannel('default', 'fallback', 'local')
      const result = JSON.parse(
        await handleChannelTool('send_message_to_channel', { text: 'hi', channel: 'foo' }, deps),
      )
      expect(result.error).toContain('Not subscribed')
    })

    it('errors when no active channel and no arg', async () => {
      const result = JSON.parse(await handleChannelTool('send_message_to_channel', { text: 'hi' }, deps))
      expect(result.error).toContain('No active channel')
    })

    it('rejects empty text', async () => {
      const result = JSON.parse(await handleChannelTool('send_message_to_channel', { text: '' }, deps))
      expect(result.error).toContain('non-empty')
    })
  })
})
