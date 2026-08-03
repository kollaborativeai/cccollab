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
  return { session, context, router: new TransportRouter([transport]) }
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
      expect(result).toEqual({ channel: 'project_x', location: 'local', becameActive: true, subscriberCount: 1 })
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

    /**
     * A DELIBERATE leave must forget the channel's delivery cursor, so a later
     * re-join re-seeds from `latestTs` and skips the backlog accrued while away.
     *
     * `joinChannel` seeds that cursor only when absent — which is what lets the
     * identity migration's TRANSIENT leave/re-join keep its place in the stream
     * and not drop broadcasts that land mid-rename. The flip side is that a
     * cursor left behind by an intentional leave would survive and the re-join
     * would replay everything since the last delivered message as fresh inbound
     * notifications. Only the tool layer knows which leave this is, so the
     * forget lives here — and this test drives the real `leave_channel` tool to
     * pin that WIRING, not just the transport method it calls.
     */
    it('forgets the remote channel cursor, so a later re-join skips the backlog', async () => {
      const forgotten: string[] = []
      const remote = {
        source: 'remote',
        enabled: true,
        hasTopic: () => false,
        introduce: vi.fn(async () => {}),
        joinChannel: vi.fn(async () => ({ subscriberCount: 1 })),
        leaveChannel: vi.fn(async () => {}),
        listChannels: vi.fn(async () => []),
        // The capability that makes this a remote transport for our purposes.
        subscribeChannelMessages: vi.fn(() => () => {}),
        forgetChannelCursor: vi.fn((channel: string) => {
          forgotten.push(channel)
        }),
      } as unknown as Transport
      const context = new ActiveContext()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const remoteDeps: ChannelToolDeps = {
        session,
        context,
        router: new TransportRouter([remote]),
        remoteChannelUnsubscribes: new Map<string, () => void>(),
      }
      remoteDeps.context.joinChannel('kai', 'manual', 'remote')

      await handleChannelTool('leave_channel', { name: 'kai', location: 'remote' }, remoteDeps)

      expect(forgotten).toEqual(['kai'])
    })

    it('does not blow up leaving a local channel, which carries no cursor', async () => {
      // The local broker replays nothing on re-join, so it exposes no
      // forgetChannelCursor — the type guard must degrade to a no-op.
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')

      const result = JSON.parse(await handleChannelTool('leave_channel', { name: 'default' }, deps))

      expect(result.removed).toBe(true)
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
          },
          {
            name: 'project_x',
            location: 'local',
            source: 'manual',
            subscriberCount: 2,
            subscribed: true,
            isActive: false,
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
          },
          {
            name: 'acme-ai',
            location: 'local',
            source: null,
            subscriberCount: 3,
            subscribed: false,
            isActive: false,
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
        { name: 'broadcast', location: 'local', source: null, subscriberCount: 5, subscribed: false, isActive: false },
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
      })
      expect(result.channels).toContainEqual({
        name: 'other',
        location: 'local',
        source: null,
        subscriberCount: 4,
        subscribed: false,
        isActive: false,
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
          },
          {
            name: 'project_x',
            location: 'local',
            source: 'manual',
            subscriberCount: 1,
            sessionCount: 1,
            subscribed: true,
            isActive: false,
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
