import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTopicTools, handleTopicTool, type TopicToolDeps } from '../../src/tools/topics.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

const RECENT_TS = (Date.now() / 1000 - 3600).toFixed(3)  // 1 hour ago - within 24h window

function createMockDeps(): TopicToolDeps {
  const context = new ActiveContext()
  context.setActiveChannel('C123', 'team-alpha-collab')
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
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
    it('returns 8 tool definitions', () => {
      expect(createTopicTools()).toHaveLength(8)
    })

    it('has correct tool names', () => {
      const names = createTopicTools().map((t) => t.name)
      expect(names).toEqual(['list_topics', 'start_topic', 'join_topic', 'send_message', 'send_broadcast', 'resolve_topic', 'deactivate_topic', 'activate_topic'])
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

      it('includes resolved topics when requested', async () => {
        const result = await handleTopicTool('list_topics', { include_resolved: true }, deps)
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
        const result = await handleTopicTool('start_topic', { topic: 'Auth refactor' }, deps)
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123',
          text: ':large_green_circle: Auth refactor',
        })
        expect(deps.context.hasTopic()).toBe(true)
        expect(deps.context.getThreadTs()).toBe('300.100')
        expect(result).toContain('Auth refactor')
        expect(result).toContain('active topic')
      })

      it('includes detail and participants as first thread reply', async () => {
        await handleTopicTool('start_topic', { topic: 'Auth refactor', detail: 'JWT vs session', participants_needed: 'backend' }, deps)
        // First call: header message
        expect(deps.postClient.chat.postMessage).toHaveBeenNthCalledWith(1, {
          channel: 'C123',
          text: ':large_green_circle: Auth refactor',
        })
        // Second call: detail in thread
        expect(deps.postClient.chat.postMessage).toHaveBeenNthCalledWith(2, {
          channel: 'C123',
          thread_ts: '300.100',
          text: expect.stringContaining('JWT vs session'),
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
        expect(result).toContain('No topic matching')
        expect(deps.context.hasTopic()).toBe(false)
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

    describe('send_message', () => {
      it('sends to active topic thread when topic is set', async () => {
        deps.context.joinTopic('300.100', 'Auth refactor', 'slack')
        await handleTopicTool('send_message', { text: 'Here is my review' }, deps)
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123', thread_ts: '300.100', text: '*[stefan]*: Here is my review',
        })
      })

      it('throws when no topic is joined', async () => {
        await expect(handleTopicTool('send_message', { text: 'Hello' }, deps)).rejects.toThrow('No active topic')
      })
    })

    describe('resolve_topic', () => {
      beforeEach(() => { deps.context.joinTopic('300.100', 'Auth refactor', 'slack') })

      it('updates parent message emoji and posts resolution', async () => {
        await handleTopicTool('resolve_topic', { summary: 'Agreed on JWT approach' }, deps)
        expect(deps.webClient.conversations.replies).toHaveBeenCalledWith({ channel: 'C123', ts: '300.100' })
        expect(deps.postClient.chat.update).toHaveBeenCalledWith({
          channel: 'C123',
          ts: '300.100',
          text: ':white_check_mark: Auth refactor',
        })
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123', thread_ts: '300.100', text: expect.stringContaining('RESOLVED'),
        })
      })

      it('clears active topic after resolving', async () => {
        await handleTopicTool('resolve_topic', { summary: 'Done' }, deps)
        expect(deps.context.hasTopic()).toBe(false)
      })

      it('returns confirmation message', async () => {
        const result = await handleTopicTool('resolve_topic', { summary: 'Agreed on JWT approach' }, deps)
        expect(result).toContain('resolved')
      })

      it('throws when no active topic', async () => {
        deps.context.clearTopic()
        await expect(handleTopicTool('resolve_topic', { summary: 'Done' }, deps)).rejects.toThrow('No active topic')
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

    it('send_message routes to local when active topic is local', async () => {
      deps.context.joinTopic('uuid-topic', 'Test topic', 'local')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('send_message', { text: 'Hello local' }, deps)
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

    it('resolve_topic routes to local when active topic is local', async () => {
      deps.context.joinTopic('uuid-resolve', 'Resolve me', 'local')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('resolve_topic', { summary: 'Decided on approach A' }, deps)
      expect(result).toContain('Topic resolved')
      expect(deps.context.hasTopic()).toBe(false)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-resolve/resolve'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('deactivate_topic routes to local when active topic is local', async () => {
      deps.context.joinTopic('uuid-deact', 'Deactivate me', 'local')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('deactivate_topic', {}, deps)
      expect(result).toContain('deactivated')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-deact/deactivate'),
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })

    it('activate_topic routes to local when no channel active', async () => {
      deps.context.clearChannel()

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topics: [
              { id: 'uuid-act', topic: 'Reactivate me', creator: 'architect', state: 'deactivated', createdAt: '2026-01-01T00:00:00Z' },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('activate_topic', { topic: 'Reactivate' }, deps)
      expect(result).toContain('reactivated')

      vi.unstubAllGlobals()
    })

    it('send_message routes to local when topic name resolves to a local topic', async () => {
      deps.context.joinTopic('uuid-named', 'Named topic', 'local')
      deps.context.joinTopic('300.100', 'Slack topic', 'slack')

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('send_message', { text: 'To local', topic: 'Named' }, deps)
      expect(result).toBe('Message sent.')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-named/messages'),
        expect.objectContaining({ method: 'POST' }),
      )
      expect(deps.postClient.chat.postMessage).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })
  })
})
