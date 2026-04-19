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

      const result = await handleTopicTool('list_topics', {}, deps)
      expect(result).toContain('No active topics in your subscribed channels')
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('sessionId=architect')
    })

    it('list_topics with explicit channel scopes broker call and rejects unsubscribed', async () => {
      const result = await handleTopicTool('list_topics', { channel: 'foo' }, deps)
      expect(result).toContain('Not subscribed')
    })

    it('list_topics with subscribed channel passes channel param', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ topics: [
          { id: 'uuid-1', topic: 'Auth design', channel: 'default', creator: 'architect', state: 'active', createdAt: '2026-01-01T00:00:00Z', messageCount: 3 },
        ] }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleTopicTool('list_topics', { channel: 'default' }, deps)
      expect(result).toContain('Auth design')
      expect(result).toContain('default')
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('channel=default')
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

      const result = await handleTopicTool('start_topic', { topic: 'DB migration' }, deps)
      expect(result).toContain('Topic started in "default"')
      expect(deps.context.hasTopic()).toBe(true)
      expect(deps.context.getThreadTs()).toBe('uuid-new')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('default')
    })

    it('start_topic with explicit unsubscribed channel rejects', async () => {
      const result = await handleTopicTool('start_topic', { topic: 'x', channel: 'nope' }, deps)
      expect(result).toContain('Not subscribed')
    })

    it('start_topic with no active channel and no arg rejects', async () => {
      const context = new ActiveContext()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      session.setName('architect')
      const deps2 = { session, context, brokerPort: 7850 }
      const result = await handleTopicTool('start_topic', { topic: 'x' }, deps2)
      expect(result).toContain('No active channel')
    })

    it('start_topic surfaces broker 409 as friendly error and does not join', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'A topic named "DB migration" already exists in "default".' }),
      })
      vi.stubGlobal('fetch', mockFetch)

      const result = await handleTopicTool('start_topic', { topic: 'DB migration' }, deps)
      expect(result).toContain('already exists')
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

      const result = await handleTopicTool('join_topic', { topic: '11111111-2222-3333-4444-555555555555' }, deps)
      expect(result).toContain('Joined topic "Direct"')
      expect(result).toContain('default')
    })

    it('join_topic rejects UUID in unsubscribed channel', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          topic: { id: '11111111-2222-3333-4444-555555555555', topic: 'Other', channel: 'other', creator: 'a', state: 'active', createdAt: '2026-01-01T00:00:00Z' },
        }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleTopicTool('join_topic', { topic: '11111111-2222-3333-4444-555555555555' }, deps)
      expect(result).toContain('not subscribed to')
    })

    it('join_topic: ambiguous matches across channels list candidates', async () => {
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
      const result = await handleTopicTool('join_topic', { topic: 'auth' }, deps)
      expect(result).toContain('Multiple topics match')
      expect(result).toContain('default')
    })

    it('join_topic joins matching topic and shows history', async () => {
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

      const result = await handleTopicTool('join_topic', { topic: 'API' }, deps)
      expect(result).toContain('Joined topic')
      expect(result).toContain('API design')
      expect(result).toContain('default')
      expect(result).toContain('REST patterns')
      expect(deps.context.hasTopic()).toBe(true)
    })

    it('set_active_topic switches among joined', async () => {
      deps.context.joinTopic('uuid-1', 'First', 'default')
      deps.context.joinTopic('uuid-2', 'Second', 'default')
      const result = await handleTopicTool('set_active_topic', { topic: 'First' }, deps)
      expect(result).toContain('First')
      expect(deps.context.getThreadTs()).toBe('uuid-1')
    })

    it('set_active_topic errors when not joined', async () => {
      const result = await handleTopicTool('set_active_topic', { topic: 'unknown' }, deps)
      expect(result).toContain('No joined topic')
    })

    it('archive_topic via active topic', async () => {
      deps.context.joinTopic('uuid-archive', 'Archive me', 'default')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleTopicTool('archive_topic', {}, deps)
      expect(result).toContain('archived')
      expect(deps.context.hasTopic()).toBe(false)
    })

    it('leave_topic via active topic', async () => {
      deps.context.joinTopic('uuid-leave', 'stale', 'default')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleTopicTool('leave_topic', {}, deps)
      expect(result).toContain('Left topic')
      expect(deps.context.hasTopic()).toBe(false)
    })

    it('send_message_to_topic routes to active topic', async () => {
      deps.context.joinTopic('uuid-topic', 'Test', 'default')
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleTopicTool('send_message_to_topic', { text: 'Hello' }, deps)
      expect(result).toBe('Message sent.')
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
      const result = await handleTopicTool('unarchive_topic', { topic: 'Unarchive' }, deps)
      expect(result).toContain('unarchived')
    })

    it('list_sessions with channel arg rejects unsubscribed', async () => {
      const result = await handleTopicTool('list_sessions', { channel: 'foo' }, deps)
      expect(result).toContain('Not subscribed')
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
      const result = await handleTopicTool('list_sessions', {}, deps)
      expect(result).toContain('architect')
      expect(result).not.toContain('stranger')
    })

    it('send_message_to_session posts to /direct-message', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleTopicTool('send_message_to_session', { to: 'bob', text: 'Hey Bob' }, deps)
      expect(result).toContain('bob')
      const calledUrl = mockFetch.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/direct-message')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.from).toBe('architect')
      expect(body.to).toBe('bob')
    })

    it('send_message_to_session surfaces 403 as friendly error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 403,
        json: () => Promise.resolve({ error: 'You and "bob" do not share any subscribed channel. Join a common channel first.' }),
        text: () => Promise.resolve(''),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleTopicTool('send_message_to_session', { to: 'bob', text: 'Hi' }, deps)
      expect(result).toContain('do not share')
    })

    it('throws on unknown tool', async () => {
      await expect(handleTopicTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown topic tool')
    })
  })
})
