import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTopicTools, handleTopicTool, type TopicToolDeps } from '../../src/tools/topics.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

const RECENT_TS = (Date.now() / 1000 - 3600).toFixed(3)  // 1 hour ago - within 24h window

function createMockDeps(): TopicToolDeps {
  const context = new ActiveContext()
  context.setChannel('C123', 'team-alpha-collab')
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
  }
}

describe('Topic Tools', () => {
  describe('createTopicTools', () => {
    it('returns 5 tool definitions', () => {
      expect(createTopicTools()).toHaveLength(5)
    })

    it('has correct tool names', () => {
      const names = createTopicTools().map((t) => t.name)
      expect(names).toEqual(['list_topics', 'start_topic', 'join_topic', 'send_message', 'resolve_topic'])
    })
  })

  describe('handleTopicTool', () => {
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

      it('throws when no active channel', async () => {
        deps.context.clearChannel()
        await expect(handleTopicTool('list_topics', {}, deps)).rejects.toThrow('No active channel')
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

      it('throws when no active channel', async () => {
        deps.context.clearChannel()
        await expect(handleTopicTool('start_topic', { topic: 'test' }, deps)).rejects.toThrow('No active channel')
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
        // Both 'Auth refactor' and 'Setup CI' would match 'e' - use a match that hits both
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

      it('throws when no active channel', async () => {
        deps.context.clearChannel()
        await expect(handleTopicTool('join_topic', { topic: 'auth' }, deps)).rejects.toThrow('No active channel')
      })
    })

    describe('send_message', () => {
      it('sends to active topic thread when topic is set', async () => {
        deps.context.setTopic('300.100', 'Auth refactor')
        await handleTopicTool('send_message', { text: 'Here is my review' }, deps)
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123', thread_ts: '300.100', text: '*[stefan]*: Here is my review',
        })
      })

      it('sends to channel when no topic is set', async () => {
        const result = await handleTopicTool('send_message', { text: 'Hello channel' }, deps)
        expect(deps.postClient.chat.postMessage).toHaveBeenCalledWith({
          channel: 'C123', text: '*[stefan]*: Hello channel',
        })
        expect(result).toContain('#team-alpha-collab')
      })

      it('throws when no active channel', async () => {
        deps.context.clearChannel()
        await expect(handleTopicTool('send_message', { text: 'hello' }, deps)).rejects.toThrow('No active channel')
      })
    })

    describe('resolve_topic', () => {
      beforeEach(() => { deps.context.setTopic('300.100', 'Auth refactor') })

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
})
