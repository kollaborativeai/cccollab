import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTopicTools, handleTopicTool, type TopicToolDeps } from '../../src/tools/topics.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

function createMockDeps(): TopicToolDeps {
  const context = new ActiveContext()
  context.joinChannel('default', 'fallback')
  const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
  session.setName('architect')
  return { session, context, brokerPort: 7850 }
}

describe('Topic Tools', () => {
  describe('createTopicTools', () => {
    it('returns 10 tool definitions', () => {
      expect(createTopicTools()).toHaveLength(10)
    })

    it('has correct tool names', () => {
      const names = createTopicTools().map((t) => t.name)
      expect(names).toEqual([
        'list_topics', 'start_topic', 'join_topic', 'leave_topic', 'set_active_topic',
        'archive_topic', 'unarchive_topic', 'send_message_to_topic',
        'list_sessions', 'send_message_to_session',
      ])
    })

    it('does not include send_broadcast', () => {
      const names = createTopicTools().map((t) => t.name)
      expect(names).not.toContain('send_broadcast')
    })
  })

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
    beforeEach(() => { deps = createMockDeps() })
    afterEach(() => { vi.unstubAllGlobals() })

    it('list_topics without channel scopes to subscribed (via sessionId)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: [] }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = JSON.parse(await handleTopicTool('list_topics', {}, deps))
      expect(result).toEqual([])
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('sessionId=architect')
    })

    it('list_topics with explicit channel rejects unsubscribed', async () => {
      const result = JSON.parse(await handleTopicTool('list_topics', { channel: 'foo' }, deps))
      expect(result.error).toContain('Not subscribed')
    })

    it('list_topics with subscribed channel returns structured JSON', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: [
          { id: 'uuid-1', topic: 'Auth design', channel: 'default', creator: 'architect', state: 'active', createdAt: '2026-01-01T00:00:00Z', messageCount: 3 },
        ] }),
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
      deps.context.joinTopic('uuid-joined', 'joined topic', 'default')
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: [
          { id: 'uuid-joined', topic: 'joined topic', channel: 'default', creator: 'architect', state: 'active', createdAt: '2026-01-01T00:00:00Z', messageCount: 0 },
          { id: 'uuid-other', topic: 'other', channel: 'default', creator: 'architect', state: 'active', createdAt: '2026-01-01T00:00:00Z', messageCount: 0 },
        ] }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('list_topics', {}, deps))
      expect(result.find((t: { id: string }) => t.id === 'uuid-joined')).toMatchObject({ isJoined: true, isMyActive: true })
      expect(result.find((t: { id: string }) => t.id === 'uuid-other')).toMatchObject({ isJoined: false, isMyActive: false })
    })

    it('start_topic creates in active channel when none specified', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'uuid-new', topic: 'DB migration', channel: 'default', creator: 'architect', state: 'active', createdAt: '2026-01-01T00:00:00Z',
        }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = JSON.parse(await handleTopicTool('start_topic', { topic: 'DB migration' }, deps))
      expect(result).toEqual({ id: 'uuid-new', name: 'DB migration', channel: 'default' })
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
      const deps2 = { session, context, brokerPort: 7850 }
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
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topic: { id: '11111111-2222-3333-4444-555555555555', topic: 'Direct', channel: 'default', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true, channel: 'default', messages: [] }),
        })
      vi.stubGlobal('fetch', mockFetch)

      const result = JSON.parse(await handleTopicTool('join_topic', { topic: '11111111-2222-3333-4444-555555555555' }, deps))
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
        json: () => Promise.resolve({
          topic: { id: '11111111-2222-3333-4444-555555555555', topic: 'Other', channel: 'other', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
        }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('join_topic', { topic: '11111111-2222-3333-4444-555555555555' }, deps))
      expect(result.error).toContain('not subscribed to')
      expect(result.channel).toBe('other')
    })

    it('join_topic: ambiguous matches return structured list', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          topics: [
            { id: 'uuid-a', topic: 'auth one', channel: 'default', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
            { id: 'uuid-b', topic: 'auth two', channel: 'default', creator: 'b', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
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
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topics: [
              { id: 'uuid-join', topic: 'API design', channel: 'default', creator: 'architect', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            ok: true, channel: 'default',
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
      deps.context.joinTopic('uuid-1', 'First', 'default')
      deps.context.joinTopic('uuid-2', 'Second', 'default')
      const result = JSON.parse(await handleTopicTool('set_active_topic', { topic: 'First' }, deps))
      expect(result).toEqual({ id: 'uuid-1', name: 'First', channel: 'default' })
      expect(deps.context.getThreadTs()).toBe('uuid-1')
    })

    it('set_active_topic errors when not joined', async () => {
      const result = JSON.parse(await handleTopicTool('set_active_topic', { topic: 'unknown' }, deps))
      expect(result.error).toContain('No joined topic')
    })

    it('archive_topic via active topic', async () => {
      deps.context.joinTopic('uuid-archive', 'Archive me', 'default')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('archive_topic', {}, deps))
      expect(result).toEqual({ id: 'uuid-archive', name: 'Archive me' })
      expect(deps.context.hasTopic()).toBe(false)
    })

    it('leave_topic via active topic', async () => {
      deps.context.joinTopic('uuid-leave', 'stale', 'default')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('leave_topic', {}, deps))
      expect(result).toEqual({ id: 'uuid-leave', name: 'stale' })
      expect(deps.context.hasTopic()).toBe(false)
    })

    it('send_message_to_topic routes to active topic', async () => {
      deps.context.joinTopic('uuid-topic', 'Test', 'default')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('send_message_to_topic', { text: 'Hello' }, deps))
      expect(result).toEqual({ topicId: 'uuid-topic' })
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/topics/uuid-topic/messages'),
        expect.objectContaining({ method: 'POST' }),
      )
    })

    it('unarchive_topic via name', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            topics: [
              { id: 'uuid-unarch', topic: 'Unarchive me', channel: 'default', creator: 'architect', state: 'archived', createdAt: '2026-01-01T00:00:00Z' },
            ],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('unarchive_topic', { topic: 'Unarchive' }, deps))
      expect(result).toEqual({ id: 'uuid-unarch', name: 'Unarchive me', channel: 'default' })
    })

    it('list_sessions with channel arg rejects unsubscribed', async () => {
      const result = JSON.parse(await handleTopicTool('list_sessions', { channel: 'foo' }, deps))
      expect(result.error).toContain('Not subscribed')
    })

    it('list_sessions filters to sessions sharing at least one subscribed channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          sessions: [
            { name: 'architect', objective: 'Design', registeredAt: '2026-01-01T00:00:00Z', channels: ['default'] },
            { name: 'stranger', registeredAt: '2026-01-01T00:00:00Z', channels: ['other'] },
          ],
        }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps))
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ name: 'architect', objective: 'Design', channels: ['default'] })
    })

    it('send_message_to_session posts to /direct-message', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ viaChannel: 'default' }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('send_message_to_session', { to: 'bob', text: 'Hey Bob' }, deps))
      expect(result).toEqual({ to: 'bob', viaChannel: 'default' })
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/direct-message')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.from).toBe('architect')
      expect(body.to).toBe('bob')
    })

    it('send_message_to_session surfaces 403 as structured error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 403,
        json: () => Promise.resolve({ error: 'You and "bob" do not share any subscribed channel. Join a common channel first.' }),
        text: () => Promise.resolve(''),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleTopicTool('send_message_to_session', { to: 'bob', text: 'Hi' }, deps))
      expect(result.error).toContain('do not share')
    })

    it('throws on unknown tool', async () => {
      await expect(handleTopicTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown topic tool')
    })
  })
})
