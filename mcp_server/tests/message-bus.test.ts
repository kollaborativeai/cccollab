import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageBus } from '../src/message-bus.js'
import type { ParsedMessage } from '../src/types.js'

function createMockMcp() {
  return { notification: vi.fn().mockResolvedValue(undefined) }
}

function createMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    sender: 'stefan | dispatcher',
    text: 'hello world',
    ts: '2026-04-19T05:00:00.000Z',
    channel: 'C123',
    channelName: undefined,
    threadTs: undefined,
    ...overrides,
  }
}

describe('MessageBus', () => {
  let bus: MessageBus
  let mockMcp: ReturnType<typeof createMockMcp>

  beforeEach(() => {
    mockMcp = createMockMcp()
    bus = new MessageBus(mockMcp as never)
  })

  describe('push', () => {
    it('pushes channel notification to Claude with source tag', async () => {
      await bus.push(createMessage())
      expect(mockMcp.notification).toHaveBeenCalledWith({
        method: 'notifications/claude/channel',
        params: {
          content: 'hello world',
          meta: {
            sender: 'stefan | dispatcher',
            channel: 'C123',
            channel_id: 'C123',
            ts: '2026-04-19T05:00:00.000Z',
            source: 'local',
          },
        },
      })
    })

    it('uses channelName for channel in meta when available', async () => {
      await bus.push(createMessage({ channelName: 'team-alpha-collab' }))
      expect(mockMcp.notification).toHaveBeenCalledWith({
        method: 'notifications/claude/channel',
        params: {
          content: 'hello world',
          meta: {
            sender: 'stefan | dispatcher',
            channel: 'team-alpha-collab',
            channel_id: 'C123',
            ts: '2026-04-19T05:00:00.000Z',
            source: 'local',
          },
        },
      })
    })

    it('includes thread_ts in meta when present', async () => {
      await bus.push(createMessage({ threadTs: '1234567890.000001' }))
      expect(mockMcp.notification).toHaveBeenCalledWith({
        method: 'notifications/claude/channel',
        params: {
          content: 'hello world',
          meta: {
            sender: 'stefan | dispatcher',
            channel: 'C123',
            channel_id: 'C123',
            ts: '2026-04-19T05:00:00.000Z',
            thread_ts: '1234567890.000001',
            source: 'local',
          },
        },
      })
    })

    it('tags remote source when passed', async () => {
      await bus.push(createMessage(), 'remote')
      expect(mockMcp.notification).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            meta: expect.objectContaining({ source: 'remote' }),
          }),
        }),
      )
    })

    it('emits on channel key', async () => {
      const listener = vi.fn()
      bus.on('channel:C123', listener)
      await bus.push(createMessage())
      expect(listener).toHaveBeenCalledWith(createMessage())
    })

    it('emits on thread key when threadTs present', async () => {
      const msg = createMessage({ threadTs: '1234567890.000001' })
      const channelListener = vi.fn()
      const threadListener = vi.fn()
      bus.on('channel:C123', channelListener)
      bus.on('thread:1234567890.000001', threadListener)
      await bus.push(msg)
      expect(channelListener).toHaveBeenCalledWith(msg)
      expect(threadListener).toHaveBeenCalledWith(msg)
    })

    it('does not emit on thread key when threadTs is undefined', async () => {
      const threadListener = vi.fn()
      bus.on('thread:undefined', threadListener)
      await bus.push(createMessage({ threadTs: undefined }))
      expect(threadListener).not.toHaveBeenCalled()
    })
  })

  describe('dedup cache', () => {
    it('drops a second identical message from either source within the dedup window', async () => {
      const dropped = vi.fn()
      bus.on('dedup:dropped', dropped)
      await bus.push(createMessage(), 'local')
      await bus.push(createMessage(), 'remote')
      expect(mockMcp.notification).toHaveBeenCalledTimes(1)
      expect(dropped).toHaveBeenCalledTimes(1)
    })

    it('treats messages in different seconds as distinct', async () => {
      await bus.push(createMessage({ ts: '2026-04-19T05:00:00.000Z' }), 'local')
      await bus.push(createMessage({ ts: '2026-04-19T05:00:02.500Z' }), 'remote')
      expect(mockMcp.notification).toHaveBeenCalledTimes(2)
    })

    it('treats messages with different text as distinct', async () => {
      await bus.push(createMessage({ text: 'ok' }), 'local')
      await bus.push(createMessage({ text: 'ok?' }), 'remote')
      expect(mockMcp.notification).toHaveBeenCalledTimes(2)
    })

    it('treats messages with different senders as distinct', async () => {
      await bus.push(createMessage({ sender: 'alice' }), 'local')
      await bus.push(createMessage({ sender: 'bob' }), 'remote')
      expect(mockMcp.notification).toHaveBeenCalledTimes(2)
    })

    it('treats messages in different topics as distinct even if text and sender match', async () => {
      await bus.push(createMessage({ threadTs: 't1' }), 'local')
      await bus.push(createMessage({ threadTs: 't2' }), 'remote')
      expect(mockMcp.notification).toHaveBeenCalledTimes(2)
    })
  })

  describe('notify failures', () => {
    it('swallows notification errors and emits notify:error', async () => {
      const failingMcp = { notification: vi.fn().mockRejectedValue(new Error('disconnected')) }
      const failingBus = new MessageBus(failingMcp as never)
      const onError = vi.fn()
      failingBus.on('notify:error', onError)
      await expect(failingBus.push(createMessage())).resolves.toBeUndefined()
      expect(onError).toHaveBeenCalledTimes(1)
    })
  })
})
