import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTopicTools, handleTopicTool, type TopicToolDeps } from '../../src/tools/topics.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

const RECENT_TS = (Date.now() / 1000 - 3600).toFixed(3)  // 1 hour ago - within 24h window

function createMockDeps(): TopicToolDeps {
  const context = new ActiveContext()
  context.setActiveChannel('C123', 'team-alpha-collab')
  const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
  session.setName('architect')
  return {
    session,
    webClient: {
      conversations: {
        history: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { text: ':large_green_circle: Auth refactor', ts: RECENT_TS, reply_count: 5 },
            { text: ':white_check_mark: Setup CI', ts: RECENT_TS, reply_count: 3 },
            { text: 'Random non-topic message', ts: RECENT_TS },
          ],
        }),
        replies: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { text: ':large_green_circle: Auth refactor', ts: '300.100', user: 'U1' },
            { text: '*[bob]*: I can help', ts: '300.200', user: 'U2' },
          ],
        }),
      },
    } as never,
    postClient: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '300.100' }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    } as never,
    subscriptionManager: { resolveChannelId: vi.fn().mockResolvedValue('C123') } as never,
    context,
    brokerPort: 7850,
  }
}

describe('Topic Tools', () => {
  describe('createTopicTools', () => {
    it('returns 10 tool definitions', () => {
      expect(createTopicTools()).toHaveLength(10)
    })

    it('has correct tool names', () => {
      const names = createTopicTools().map((t) => t.name)
      expect(names).toEqual(['list_topics', 'start_topic', 'join_topic', 'leave_topic', 'archive_topic', 'unarchive_topic', 'send_message_to_topic', 'send_broadcast', 'list_sessions', 'send_message_to_session'])
    })
  })

  describe('requires name', () => {
    it('returns error when session has no name and tries to start_topic', async () => {
      const deps = createMockDeps()
      // Reset to no name
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      const result = await handleTopicTool('start_topic', { topic: 'Test' }, depsNoName)
      expect(result).toContain('no name set')
      expect(result).toContain('introduce')
    })

    it('returns error when session has no name and tries to send_message_to_topic', async () => {
      const deps = createMockDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      const result = await handleTopicTool('send_message_to_topic', { text: 'Hi' }, depsNoName)
      expect(result).toContain('no name set')
    })

    it('allows list_topics without name', async () => {
      const deps = createMockDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      const result = await handleTopicTool('list_topics', {}, depsNoName)
      expect(result).not.toContain('no name set')
    })
  })

  describe('handleTopicTool - Slack channel', () => {
    let deps: TopicToolDeps
    beforeEach(() => { deps = createMockDeps() })

    describe('list_topics', () => {
      it('returns active topics only by default', async () => {
        const result = await handleTopicTool('list_topics', {}, deps)
        expect(result).toContain('Auth refactor')
        expect(result).not.toContain('Setup CI')
      })

      it('includes archived topics when requested', async () => {
        const result = await handleTopicTool('list_topics', { include_archived: true }, deps)
        expect(result).toContain('Auth refactor')
        expect(result).toContain('Setup CI')
      })

      it('filters by hours window', async () => {
        // Set ts to 48 hours ago - should be excluded by default 24h window
        const oldTs = (Date.now() / 1000 - 48 * 3600).toFixed(3)
        ;(deps.webClient.conversations.history as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          messages: [
            { text: ':large_green_circle: TOPIC: Old topic | *[alice]*', ts: oldTs, reply_count: 0 },
          ],
        })
        const result = await handleTopicTool('list_topics', {}, deps)
        expect(result).toContain('No active topics')
      })
    })

    describe('start_topic', () => {
      it('posts topic message and sets active topic', async () => {
        const result = await handleTopicTool('start_topic', { topic: 'Perf tuning' }, deps)
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123',
          text: ':large_green_circle: Perf tuning',
        })
        expect(deps.context.hasTopic()).toBe(true)
        expect(deps.context.getThreadTs()).toBe('300.100')
        expect(result).toContain('Perf tuning')
        expect(result).toContain('active topic')
      })

      it('includes detail and participants as first thread reply', async () => {
        await handleTopicTool('start_topic', { topic: 'Perf tuning', detail: 'JWT vs session', participants_needed: 'backend' }, deps)
        // First call: header message
        expect(deps.postClient.chat.postMessage).toHaveBeenNthCalledWith(1, {
          channel: 'C123',
          text: ':large_green_circle: Perf tuning',
        })
        // Second call: detail in thread
        expect(deps.postClient.chat.postMessage).toHaveBeenNthCalledWith(2, {
          channel: 'C123',
          thread_ts: '300.100',
          text: expect.stringContaining('JWT vs session'),
        })
      })

      it('rejects duplicate active topic name (case-insensitive)', async () => {
        const result = await handleTopicTool('start_topic', { topic: 'auth REFACTOR' }, deps)
        expect(result).toContain('already exists')
        expect(result).toContain('Auth refactor')
        expect(deps.postClient.chat.postMessage).not.toHaveBeenCalled()
        expect(deps.context.hasTopic()).toBe(false)
      })

      it('allows reusing an archived topic name', async () => {
        // Mock history has archived "Setup CI"
        const result = await handleTopicTool('start_topic', { topic: 'Setup CI' }, deps)
        expect(result).toContain('Setup CI')
        expect(result).toContain('active topic')
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123',
          text: ':large_green_circle: Setup CI',
        })
      })
    })

    describe('join_topic', () => {
      it('joins by fuzzy name match', async () => {
        const result = await handleTopicTool('join_topic', { topic: 'auth' }, deps)
        expect(deps.webClient.conversations.replies).toHaveBeenCalledWith({ channel: 'C123', ts: RECENT_TS })
        expect(deps.context.hasTopic()).toBe(true)
        expect(result).toContain('Auth refactor')
        expect(result).toContain('active topic')
      })

      it('shows history after joining', async () => {
        const result = await handleTopicTool('join_topic', { topic: 'auth' }, deps)
        expect(result).toContain('Auth refactor')
        expect(result).toContain('bob')
      })

      it('joins by exact thread_ts', async () => {
        const result = await handleTopicTool('join_topic', { topic: '300.100' }, deps)
        expect(deps.webClient.conversations.replies).toHaveBeenCalledWith({ channel: 'C123', ts: '300.100' })
        expect(deps.context.hasTopic()).toBe(true)
        expect(result).toContain('active topic')
      })

      it('returns error when no match', async () => {
        const result = await handleTopicTool('join_topic', { topic: 'nonexistent xyz' }, deps)
        expect(result).toContain('No active topic matching')
        expect(deps.context.hasTopic()).toBe(false)
      })

      it('exact match wins over substring match', async () => {
        ;(deps.webClient.conversations.history as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          messages: [
            { text: ':large_green_circle: test', ts: RECENT_TS, reply_count: 0 },
            { text: ':large_green_circle: test this', ts: (parseFloat(RECENT_TS) + 1).toFixed(3), reply_count: 0 },
          ],
        })
        const result = await handleTopicTool('join_topic', { topic: 'test' }, deps)
        expect(result).toContain('Joined topic "test"')
        expect(result).not.toContain('Multiple topics')
      })

      it('excludes archived topics from fuzzy matching', async () => {
        ;(deps.webClient.conversations.history as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          messages: [
            { text: ':white_check_mark: test', ts: RECENT_TS, reply_count: 0 },
            { text: ':large_green_circle: test this', ts: (parseFloat(RECENT_TS) + 1).toFixed(3), reply_count: 0 },
          ],
        })
        const result = await handleTopicTool('join_topic', { topic: 'test' }, deps)
        expect(result).toContain('Joined topic "test this"')
      })

      it('lists multiple matches when ambiguous', async () => {
        ;(deps.webClient.conversations.history as ReturnType<typeof vi.fn>).mockResolvedValue({
          ok: true,
          messages: [
            { text: ':large_green_circle: TOPIC: auth one | *[alice]*', ts: RECENT_TS, reply_count: 0 },
            { text: ':large_green_circle: TOPIC: auth two | *[bob]*', ts: RECENT_TS, reply_count: 0 },
          ],
        })
        const result = await handleTopicTool('join_topic', { topic: 'auth' }, deps)
        expect(result).toContain('Multiple topics match')
        expect(result).toContain('auth one')
        expect(result).toContain('auth two')
        expect(deps.context.hasTopic()).toBe(false)
      })

      it('does not post a join announcement', async () => {
        await handleTopicTool('join_topic', { topic: 'auth' }, deps)
        expect(deps.postClient.chat.postMessage).not.toHaveBeenCalled()
      })
    })

    describe('send_message_to_topic', () => {
      it('sends to active topic thread when topic is set', async () => {
        deps.context.joinTopic('300.100', 'Auth refactor', 'slack')
        await handleTopicTool('send_message_to_topic', { text: 'Here is my review' }, deps)
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123', thread_ts: '300.100', text: '*[architect]*: Here is my review',
        })
      })

      it('throws when no topic is joined', async () => {
        await expect(handleTopicTool('send_message_to_topic', { text: 'Hello' }, deps)).rejects.toThrow('No active topic')
      })
    })

    describe('archive_topic', () => {
      beforeEach(() => { deps.context.joinTopic('300.100', 'Auth refactor', 'slack') })

      it('updates parent message emoji and posts archive notice', async () => {
        await handleTopicTool('archive_topic', {}, deps)
        expect(deps.webClient.conversations.replies).toHaveBeenCalledWith({ channel: 'C123', ts: '300.100' })
        expect(deps.postClient.chat.update).toHaveBeenCalledWith({
          channel: 'C123',
          ts: '300.100',
          text: ':white_check_mark: Auth refactor',
        })
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123', thread_ts: '300.100', text: expect.stringContaining('Archived'),
        })
      })

      it('leaves topic after archiving', async () => {
        await handleTopicTool('archive_topic', {}, deps)
        expect(deps.context.hasTopic()).toBe(false)
      })

      it('returns confirmation message', async () => {
        const result = await handleTopicTool('archive_topic', {}, deps)
        expect(result).toContain('archived')
      })

      it('returns error when no active topic', async () => {
        deps.context.clearTopic()
        const result = await handleTopicTool('archive_topic', {}, deps)
        expect(result).toContain('No active topic')
      })
    })

    it('throws on unknown tool', async () => {
      await expect(handleTopicTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown topic tool')
    })
  })

  describe('handleTopicTool - local routing', () => {
    let deps: TopicToolDeps

    beforeEach(() => {
      deps = createMockDeps()
    })

    it('routes to local when channel is "local" even with active Slack channel', async () => {
      // Mock fetch for broker
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: [] }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('list_topics', { channel: 'local' }, deps)
      expect(result).toContain('No active local topics')
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/topics?'), undefined)

      vi.unstubAllGlobals()
    })

    it('routes to local when no channel is active', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          topics: [
            { id: 'uuid-1', topic: 'Auth design', creator: 'architect', state: 'active', createdAt: '2026-01-01T00:00:00Z', messageCount: 3 },
          ],
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('list_topics', {}, deps)
      expect(result).toContain('Local topics')
      expect(result).toContain('Auth design')

      vi.unstubAllGlobals()
    })

    it('start_topic creates local topic via broker', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'uuid-new', topic: 'DB migration', creator: 'stefan', state: 'active', createdAt: '2026-01-01T00:00:00Z',
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('start_topic', { topic: 'DB migration' }, deps)
      expect(result).toContain('Local topic started')
      expect(result).toContain('DB migration')
      expect(deps.context.hasTopic()).toBe(true)
      expect(deps.context.getThreadTs()).toBe('uuid-new')
      expect(deps.context.getTopicSource()).toBe('local')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('start_topic surfaces broker 409 as friendly error and does not join', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({
          error: 'A local topic named "DB migration" already exists. Join it instead, or use a different name.',
          existing: { id: 'uuid-existing', topic: 'DB migration', creator: 'other', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('start_topic', { topic: 'DB migration' }, deps)
      expect(result).toContain('already exists')
      expect(result).toContain('DB migration')
      expect(deps.context.hasTopic()).toBe(false)

      vi.unstubAllGlobals()
    })

    it('join_topic local: exact match wins over substring match', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topics: [
              { id: 'uuid-test', topic: 'test', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
              { id: 'uuid-test-this', topic: 'test this', creator: 'b', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true, messages: [] }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('join_topic', { topic: 'test' }, deps)
      expect(result).toContain('Joined local topic "test"')
      expect(result).not.toContain('Multiple')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-test/join'),
        expect.anything(),
      )

      vi.unstubAllGlobals()
    })

    it('join_topic local: accepts UUID directly', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topic: { id: '11111111-2222-3333-4444-555555555555', topic: 'Direct', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true, messages: [] }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('join_topic', { topic: '11111111-2222-3333-4444-555555555555' }, deps)
      expect(result).toContain('Joined local topic "Direct"')

      vi.unstubAllGlobals()
    })

    it('archive_topic local: works without channel when given topic name', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topics: [
              { id: 'uuid-r', topic: 'to be archived', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('archive_topic', { topic: 'to be archived' }, deps)
      expect(result).toContain('archived')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-r/archive'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('leave_topic local: clears active topic and calls broker leave', async () => {
      deps.context.clearChannel()
      deps.context.joinTopic('uuid-leave', 'stale topic', 'local')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('leave_topic', {}, deps)
      expect(result).toContain('Left topic')
      expect(deps.context.hasTopic()).toBe(false)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-leave/leave'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('join_topic joins local topic via broker', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topics: [
              { id: 'uuid-join', topic: 'API design', creator: 'architect', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            messages: [
              { sender: 'architect', text: 'Let us discuss REST patterns', ts: '2026-01-01T00:00:01Z' },
            ],
          }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('join_topic', { topic: 'API' }, deps)
      expect(result).toContain('Joined local topic')
      expect(result).toContain('API design')
      expect(result).toContain('REST patterns')
      expect(deps.context.hasTopic()).toBe(true)
      expect(deps.context.getTopicSource()).toBe('local')

      vi.unstubAllGlobals()
    })

    it('send_message_to_topic routes to local when active topic is local', async () => {
      deps.context.joinTopic('uuid-topic', 'Test topic', 'local')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('send_message_to_topic', { text: 'Hello local' }, deps)
      expect(result).toBe('Message sent.')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-topic/messages'),
        expect.objectContaining({ method: 'POST' }),
      )
      // Should NOT call Slack postClient
      expect(deps.postClient.chat.postMessage).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('send_broadcast routes to local when no channel active', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('send_broadcast', { text: 'Heads up everyone' }, deps)
      expect(result).toContain('Broadcast sent in local')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/broadcast'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('archive_topic routes to local when active topic is local', async () => {
      deps.context.joinTopic('uuid-archive', 'Archive me', 'local')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('archive_topic', {}, deps)
      expect(result).toContain('archived')
      expect(deps.context.hasTopic()).toBe(false)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-archive/archive'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('leave_topic routes to local when active topic is local', async () => {
      deps.context.joinTopic('uuid-leave2', 'Leave me', 'local')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('leave_topic', {}, deps)
      expect(result).toContain('Left topic')
      expect(deps.context.hasTopic()).toBe(false)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-leave2/leave'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('unarchive_topic routes to local when no channel active', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topics: [
              { id: 'uuid-unarch', topic: 'Unarchive me', creator: 'architect', state: 'archived', createdAt: '2026-01-01T00:00:00Z' },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('unarchive_topic', { topic: 'Unarchive' }, deps)
      expect(result).toContain('unarchived')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-unarch/unarchive'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('send_message_to_topic routes to local when topic name resolves to a local topic', async () => {
      deps.context.joinTopic('uuid-named', 'Named topic', 'local')
      deps.context.joinTopic('300.100', 'Slack topic', 'slack')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('send_message_to_topic', { text: 'To local', topic: 'Named' }, deps)
      expect(result).toBe('Message sent.')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-named/messages'),
        expect.objectContaining({ method: 'POST' }),
      )
      expect(deps.postClient.chat.postMessage).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })

    it('send_message_to_topic posts to unjoined local topic without joining', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn()
        // resolveLocalTopicId list call
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topics: [{ id: 'uuid-unjoined', topic: 'Unjoined topic', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' }],
          }),
        })
        // messages POST
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('send_message_to_topic', { text: 'Hello from outside', topic: 'Unjoined' }, deps)
      expect(result).toBe('Message sent.')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-unjoined/messages'),
        expect.objectContaining({ method: 'POST' }),
      )
      // Should NOT have joined the topic
      expect(deps.context.isTopicJoined('uuid-unjoined')).toBe(false)

      vi.unstubAllGlobals()
    })

    it('list_sessions fetches from /sessions and formats result', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sessions: [
            { name: 'architect', objective: 'Design API', registeredAt: '2026-01-01T00:00:00Z' },
            { name: 'reviewer', registeredAt: '2026-01-01T00:00:01Z' },
          ],
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('list_sessions', {}, deps)
      expect(result).toContain('architect')
      expect(result).toContain('Design API')
      expect(result).toContain('reviewer')
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/sessions'), undefined)

      vi.unstubAllGlobals()
    })

    it('send_message_to_session posts direct_message to /local-event', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('send_message_to_session', { to: 'bob', text: 'Hey Bob' }, deps)
      expect(result).toContain('bob')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.type).toBe('direct_message')
      expect(body.to).toBe('bob')
      expect(body.text).toBe('Hey Bob')

      vi.unstubAllGlobals()
    })
  })
})
