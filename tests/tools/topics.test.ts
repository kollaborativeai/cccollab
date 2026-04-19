import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTopicTools, handleTopicTool, type TopicToolDeps } from '../../src/tools/topics.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

function createMockDeps(): TopicToolDeps {
  const context = new ActiveContext()
  context.joinLocalChannel()
  const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
  session.setName('architect')
  return {
    session,
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
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ topics: [] }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleTopicTool('list_topics', {}, depsNoName)
      expect(result).not.toContain('no name set')
      vi.unstubAllGlobals()
    })
  })

  describe('handleTopicTool - local', () => {
    let deps: TopicToolDeps
    beforeEach(() => { deps = createMockDeps() })

    it('list_topics returns "No active local topics" when broker returns empty', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: [] }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('list_topics', {}, deps)
      expect(result).toContain('No active local topics')
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/topics?'), undefined)

      vi.unstubAllGlobals()
    })

    it('list_topics formats broker topic list', async () => {
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

    it('join_topic: exact match wins over substring match', async () => {
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

    it('join_topic: accepts UUID directly', async () => {
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

    it('join_topic: ambiguous matches list candidates', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          topics: [
            { id: 'uuid-a', topic: 'auth one', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
            { id: 'uuid-b', topic: 'auth two', creator: 'b', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
          ],
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('join_topic', { topic: 'auth' }, deps)
      expect(result).toContain('Multiple local topics match')
      expect(result).toContain('auth one')
      expect(result).toContain('auth two')
      expect(deps.context.hasTopic()).toBe(false)

      vi.unstubAllGlobals()
    })

    it('join_topic: no match returns error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: [] }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('join_topic', { topic: 'nonexistent xyz' }, deps)
      expect(result).toContain('No active local topic matching')
      expect(deps.context.hasTopic()).toBe(false)

      vi.unstubAllGlobals()
    })

    it('join_topic joins local topic via broker and shows history', async () => {
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

    it('archive_topic via active topic', async () => {
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

    it('archive_topic works with no active topic when given topic name', async () => {
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

    it('leave_topic via active topic', async () => {
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

    it('send_message_to_topic routes to active local topic', async () => {
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

      vi.unstubAllGlobals()
    })

    it('send_broadcast posts to /broadcast', async () => {
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

    it('unarchive_topic via topic name', async () => {
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

    it('send_message_to_topic posts to unjoined local topic without joining', async () => {
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
      expect(deps.context.isTopicJoined('uuid-unjoined')).toBe(false)

      vi.unstubAllGlobals()
    })

    it('list_sessions fetches from /sessions and formats result', async () => {
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

    it('throws on unknown tool', async () => {
      await expect(handleTopicTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown topic tool')
    })
  })
})
