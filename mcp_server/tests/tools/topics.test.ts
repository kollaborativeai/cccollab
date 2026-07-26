import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleTopicTool, type TopicToolDeps } from '../../src/tools/topics.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'
import { LocalTransport } from '../../src/transport/local.js'
import { TransportRouter } from '../../src/transport/router.js'

function createMockDeps(): TopicToolDeps {
  const context = new ActiveContext()
  context.joinChannel('default', 'fallback', 'local')
  const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
  session.setName('architect')
  const transport = new LocalTransport(7850)
  return { session, context, router: new TransportRouter([transport]) }
}

describe('Topic Tools', () => {
  describe('requires name', () => {
    it('returns error when session has no name and tries to start_topic', async () => {
      const deps = createMockDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      const result = JSON.parse(await handleTopicTool('start_topic', { topic: 'Test' }, depsNoName))
      expect(result.error).toContain('No name set')
      expect(result.error).toContain('introduce')
    })

    it('returns error when session has no name and tries to send_message_to_topic', async () => {
      const deps = createMockDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      const result = JSON.parse(await handleTopicTool('send_message_to_topic', { text: 'Hi' }, depsNoName))
      expect(result.error).toContain('No name set')
    })

    it('returns error when session has no name and tries to send_message_to_session', async () => {
      const deps = createMockDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      const result = JSON.parse(
        await handleTopicTool('send_message_to_session', { sessionId: 'x', text: 'Hi' }, depsNoName),
      )
      expect(result.error).toContain('No name set')
    })

    it('returns error when session has no name and tries to read_session_messages', async () => {
      const deps = createMockDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      const result = JSON.parse(await handleTopicTool('read_session_messages', { sessionId: 'x' }, depsNoName))
      expect(result.error).toContain('No name set')
    })

    it('allows list_topics without name', async () => {
      const deps = createMockDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ topics: [] }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('list_topics', {}, depsNoName))
      expect(result).toEqual([])
      vi.unstubAllGlobals()
    })
  })

  describe('handleTopicTool', () => {
    let deps: TopicToolDeps
    beforeEach(() => {
      deps = createMockDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('list_topics without channel iterates per subscribed channel at each location', async () => {
      // Post-bug-A fix: handleListTopics's no-channel branch fans out
      // per subscribed channel per transport instead of passing
      // sessionName to the transport. The broker URL therefore contains
      // `channel=<name>` for each subscribed channel (here: "default").
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: [] }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = JSON.parse(await handleTopicTool('list_topics', {}, deps))
      expect(result).toEqual([])
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('channel=default')
    })

    it('list_topics with explicit channel rejects unsubscribed', async () => {
      const result = JSON.parse(await handleTopicTool('list_topics', { channel: 'foo' }, deps))
      expect(result.error).toContain('Not subscribed')
    })

    it('list_topics with subscribed channel returns structured JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            topics: [
              {
                id: 'uuid-1',
                topic: 'Auth design',
                channel: 'default',
                creator: 'architect',
                state: 'active',
                createdAt: '2026-01-01T00:00:00Z',
                messageCount: 3,
              },
            ],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('list_topics', { channel: 'default' }, deps))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'uuid-1',
        name: 'Auth design',
        channel: 'default',
        state: 'active',
        messageCount: 3,
        isJoined: false,
        isMyActive: false,
        creator: 'architect',
      })
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('channel=default')
    })

    it('list_topics flags isJoined and isMyActive per topic', async () => {
      deps.context.joinTopic('uuid-joined', 'joined topic', 'default', 'local')
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            topics: [
              {
                id: 'uuid-joined',
                topic: 'joined topic',
                channel: 'default',
                creator: 'architect',
                state: 'active',
                createdAt: '2026-01-01T00:00:00Z',
                messageCount: 0,
              },
              {
                id: 'uuid-other',
                topic: 'other',
                channel: 'default',
                creator: 'architect',
                state: 'active',
                createdAt: '2026-01-01T00:00:00Z',
                messageCount: 0,
              },
            ],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('list_topics', {}, deps))
      expect(result.find((t: { id: string }) => t.id === 'uuid-joined')).toMatchObject({
        isJoined: true,
        isMyActive: true,
      })
      expect(result.find((t: { id: string }) => t.id === 'uuid-other')).toMatchObject({
        isJoined: false,
        isMyActive: false,
      })
    })

    it('list_topics prefers the backend joined flag over stale local context', async () => {
      // The backend reports per-session topic membership. When it does, it
      // wins over the MCP server's in-memory context — which goes stale if
      // the session is removed from a topic elsewhere (e.g. the web hub).
      const stubTransport = {
        source: 'remote',
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
        listTopics: async () => [
          // Backend says joined; context does NOT have it joined.
          {
            id: 'uuid-backend-joined',
            topic: 'backend joined',
            channel: 'default',
            creator: 'architect',
            state: 'active',
            createdAt: '2026-01-01T00:00:00Z',
            joined: true,
          },
          // Backend says left; context still has it joined (stale).
          {
            id: 'uuid-backend-left',
            topic: 'backend left',
            channel: 'default',
            creator: 'architect',
            state: 'active',
            createdAt: '2026-01-01T00:00:00Z',
            joined: false,
          },
        ],
        getTopicById: async () => null,
        joinTopic: async () => ({ history: [] }),
        leaveTopic: async () => {},
        archiveTopic: async () => {},
        unarchiveTopic: async () => {},
        sendTopicMessage: async () => {},
        listSessions: async () => [],
        deregisterSession: async () => {},
        readChannelMessages: async () => ({ messages: [], hasMore: false }),
        readTopicMessages: async () => ({ messages: [], hasMore: false }),
      }
      const context = new ActiveContext()
      context.joinChannel('default', 'manual', 'remote')
      context.joinTopic('uuid-backend-left', 'backend left', 'default', 'remote')
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const stubDeps: TopicToolDeps = {
        session,
        context,
        router: new TransportRouter([stubTransport as unknown as import('../../src/transport/index.js').Transport]),
      }
      const result = JSON.parse(await handleTopicTool('list_topics', {}, stubDeps))
      expect(result.find((t: { id: string }) => t.id === 'uuid-backend-joined').isJoined).toBe(true)
      expect(result.find((t: { id: string }) => t.id === 'uuid-backend-left').isJoined).toBe(false)
    })

    it('start_topic creates in active channel when none specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            id: 'uuid-new',
            topic: 'DB migration',
            channel: 'default',
            creator: 'architect',
            state: 'active',
            createdAt: '2026-01-01T00:00:00Z',
          }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = JSON.parse(await handleTopicTool('start_topic', { topic: 'DB migration' }, deps))
      expect(result).toEqual({ id: 'uuid-new', name: 'DB migration', channel: 'default', location: 'local' })
      expect(deps.context.hasTopic()).toBe(true)
      expect(deps.context.getThreadTs()).toBe('uuid-new')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('default')
    })

    it('start_topic with explicit unsubscribed channel rejects', async () => {
      const result = JSON.parse(await handleTopicTool('start_topic', { topic: 'x', channel: 'nope' }, deps))
      expect(result.error).toContain('Not subscribed')
    })

    it('start_topic with no active channel and no arg rejects', async () => {
      const context = new ActiveContext()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const deps2 = { session, context, router: new TransportRouter([new LocalTransport(7850)]) }
      const result = JSON.parse(await handleTopicTool('start_topic', { topic: 'x' }, deps2))
      expect(result.error).toContain('No active channel')
    })

    it('start_topic surfaces broker 409 as structured error and does not join', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'A topic named "DB migration" already exists in "default".' }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = JSON.parse(await handleTopicTool('start_topic', { topic: 'DB migration' }, deps))
      expect(result.error).toContain('already exists')
      expect(result.channel).toBe('default')
      expect(result.name).toBe('DB migration')
      expect(deps.context.hasTopic()).toBe(false)
    })

    it('join_topic accepts UUID directly and joins', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              topic: {
                id: '11111111-2222-3333-4444-555555555555',
                topic: 'Direct',
                channel: 'default',
                creator: 'a',
                state: 'active',
                createdAt: '2026-01-01T00:00:00Z',
              },
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true, channel: 'default', messages: [] }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = JSON.parse(
        await handleTopicTool('join_topic', { topic: '11111111-2222-3333-4444-555555555555' }, deps),
      )
      expect(result).toMatchObject({
        id: '11111111-2222-3333-4444-555555555555',
        name: 'Direct',
        channel: 'default',
        history: [],
      })
    })

    it('join_topic rejects UUID in unsubscribed channel', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            topic: {
              id: '11111111-2222-3333-4444-555555555555',
              topic: 'Other',
              channel: 'other',
              creator: 'a',
              state: 'active',
              createdAt: '2026-01-01T00:00:00Z',
            },
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(
        await handleTopicTool('join_topic', { topic: '11111111-2222-3333-4444-555555555555' }, deps),
      )
      expect(result.error).toContain('not subscribed to')
      expect(result.channel).toBe('other')
    })

    it('join_topic: ambiguous matches return structured list', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            topics: [
              {
                id: 'uuid-a',
                topic: 'auth one',
                channel: 'default',
                creator: 'a',
                state: 'active',
                createdAt: '2026-01-01T00:00:00Z',
              },
              {
                id: 'uuid-b',
                topic: 'auth two',
                channel: 'default',
                creator: 'b',
                state: 'active',
                createdAt: '2026-01-01T00:00:00Z',
              },
            ],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('join_topic', { topic: 'auth' }, deps))
      expect(result.error).toContain('Multiple topics match')
      expect(result.matches).toHaveLength(2)
      expect(result.matches[0]).toMatchObject({ channel: 'default' })
    })

    it('join_topic joins matching topic and returns history', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              topics: [
                {
                  id: 'uuid-join',
                  topic: 'API design',
                  channel: 'default',
                  creator: 'architect',
                  state: 'active',
                  createdAt: '2026-01-01T00:00:00Z',
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              channel: 'default',
              messages: [{ sender: 'architect', text: 'Let us discuss REST patterns', ts: '2026-01-01T00:00:01Z' }],
            }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = JSON.parse(await handleTopicTool('join_topic', { topic: 'API' }, deps))
      expect(result.name).toBe('API design')
      expect(result.channel).toBe('default')
      expect(result.history).toHaveLength(1)
      expect(result.history[0].text).toBe('Let us discuss REST patterns')
      expect(deps.context.hasTopic()).toBe(true)
    })

    it('set_active_topic switches among joined', async () => {
      deps.context.joinTopic('uuid-1', 'First', 'default', 'local')
      deps.context.joinTopic('uuid-2', 'Second', 'default', 'local')
      const result = JSON.parse(await handleTopicTool('set_active_topic', { topic: 'First' }, deps))
      expect(result).toEqual({ id: 'uuid-1', name: 'First', channel: 'default', location: 'local' })
      expect(deps.context.getThreadTs()).toBe('uuid-1')
    })

    it('set_active_topic errors when not joined', async () => {
      const result = JSON.parse(await handleTopicTool('set_active_topic', { topic: 'unknown' }, deps))
      expect(result.error).toContain('No joined topic')
    })

    it('archive_topic keeps the archiver joined (KAI-373)', async () => {
      deps.context.joinTopic('uuid-archive', 'Archive me', 'default', 'local')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('archive_topic', {}, deps))
      expect(result).toEqual({ id: 'uuid-archive', name: 'Archive me' })
      // Archiving must NOT drop the archiver's own membership: the peer stays
      // joined, so dropping only the archiver's was asymmetric (KAI-373).
      expect(deps.context.isTopicJoined('uuid-archive')).toBe(true)
    })

    it('leave_topic via active topic', async () => {
      deps.context.joinTopic('uuid-leave', 'stale', 'default', 'local')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('leave_topic', {}, deps))
      expect(result).toEqual({ id: 'uuid-leave', name: 'stale' })
      expect(deps.context.hasTopic()).toBe(false)
    })

    it('send_message_to_topic routes to active topic', async () => {
      deps.context.joinTopic('uuid-topic', 'Test', 'default', 'local')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('send_message_to_topic', { text: 'Hello' }, deps))
      expect(result).toEqual({ topicId: 'uuid-topic' })
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-topic/messages'),
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('unarchive_topic via name restores membership and attributes the actor (KAI-373)', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              topics: [
                {
                  id: 'uuid-unarch',
                  topic: 'Unarchive me',
                  channel: 'default',
                  creator: 'architect',
                  state: 'archived',
                  createdAt: '2026-01-01T00:00:00Z',
                },
              ],
            }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) }) // unarchive
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ messages: [] }) }) // join (restore membership)
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('unarchive_topic', { topic: 'Unarchive' }, deps))
      expect(result).toEqual({ id: 'uuid-unarch', name: 'Unarchive me', channel: 'default', location: 'local' })
      // Unarchiving restores the acting session's membership so isJoined is true
      // again — symmetric with archive keeping it (KAI-373).
      expect(deps.context.isTopicJoined('uuid-unarch')).toBe(true)
      // The unarchive request carries who unarchived, mirroring archive's archivedBy.
      const unarchiveCall = mockFetch.mock.calls.find((call) => String(call[0]).includes('/unarchive'))
      expect(unarchiveCall).toBeDefined()
      expect(JSON.parse(unarchiveCall![1].body)).toEqual({ unarchivedBy: 'architect' })
    })

    it('list_sessions with channel arg rejects unsubscribed', async () => {
      const result = JSON.parse(await handleTopicTool('list_sessions', { channel: 'foo' }, deps))
      expect(result.error).toContain('Not subscribed')
    })

    it('list_sessions filters to sessions sharing at least one subscribed channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: [
              { name: 'architect', objective: 'Design', registeredAt: '2026-01-01T00:00:00Z', channels: ['default'] },
              { name: 'stranger', registeredAt: '2026-01-01T00:00:00Z', channels: ['other'] },
            ],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        name: 'architect',
        objective: 'Design',
        channels: [{ name: 'default', location: 'local' }],
      })
    })

    it('list_sessions keeps remote sessions even though the transport reports no channels', async () => {
      // The remote backend's listSessions is already scoped server-side
      // to shared-channel peers but cannot denormalize which channels,
      // so it returns `channels: []`. The no-channel filter must not
      // drop those sessions.
      const remoteTransport = {
        source: 'remote',
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
        listSessions: async () => [
          { name: 'reviewer', objective: 'Review', channels: [], registeredAt: '2026-01-01T00:00:00Z' },
        ],
        deregisterSession: async () => {},
        readChannelMessages: async () => ({ messages: [], hasMore: false }),
        readTopicMessages: async () => ({ messages: [], hasMore: false }),
      }
      const context = new ActiveContext()
      context.joinChannel('default', 'fallback', 'remote')
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const remoteDeps: TopicToolDeps = {
        session,
        context,
        router: new TransportRouter([remoteTransport as unknown as import('../../src/transport/index.js').Transport]),
      }
      const result = JSON.parse(await handleTopicTool('list_sessions', {}, remoteDeps))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ name: 'reviewer', objective: 'Review', channels: [] })
    })

    it('throws on unknown tool', async () => {
      await expect(handleTopicTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown topic tool')
    })

    // Direct messaging was removed once (feat(mcp)!: remove direct
    // messaging) because the *remote* transport's DM subscription called
    // a Convex function that no longer existed, and a missing function
    // used to disable the entire remote transport. KAI-333 fixed that
    // root cause (a missing remote function now only skips that one
    // tool), and KAI-514 reintroduces direct messaging on the local
    // transport only, addressed by stable id rather than by name.
    it('send_message_to_session requires sessionId and text', async () => {
      const result = JSON.parse(await handleTopicTool('send_message_to_session', { text: 'hi' }, deps))
      expect(result.error).toMatch(/sessionId/i)
    })

    it('read_session_messages requires sessionId', async () => {
      const result = JSON.parse(await handleTopicTool('read_session_messages', {}, deps))
      expect(result.error).toMatch(/sessionId/i)
    })

    it('read_topic_messages returns paged topic history from the transport', async () => {
      const page = {
        messages: [{ sender: 'peer', senderSessionName: 'peer', text: 'topic msg', ts: 1_767_312_000_000 }],
        hasMore: false,
        oldestTs: 1_767_312_000_000,
      }
      const stubTransport = {
        source: 'local',
        enabled: true,
        hasTopic: (id: string) => id === 'uuid-hist',
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
        readChannelMessages: async () => ({ messages: [], hasMore: false }),
        readTopicMessages: vi.fn().mockResolvedValue(page),
      }
      const context = new ActiveContext()
      context.joinChannel('default', 'fallback', 'local')
      context.joinTopic('uuid-hist', 'History topic', 'default', 'local')
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const stubDeps: TopicToolDeps = {
        session,
        context,
        router: new TransportRouter([stubTransport as unknown as import('../../src/transport/index.js').Transport]),
      }
      const result = JSON.parse(await handleTopicTool('read_topic_messages', { topic: 'uuid-hist' }, stubDeps))
      expect(result.messages[0].text).toBe('topic msg')
      expect(result.hasMore).toBe(false)
    })
  })
})
