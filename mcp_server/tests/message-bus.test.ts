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
    ts: '1234567890.123456',
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
    it('pushes channel notification to Claude', async () => {
      await bus.push(createMessage())
      expect(mockMcp.notification).toHaveBeenCalledWith({
        method: 'notifications/claude/channel',
        params: {
          content: 'hello world',
          meta: { sender: 'stefan | dispatcher', channel: 'C123', channel_id: 'C123', ts: '1234567890.123456' },
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
            ts: '1234567890.123456',
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
            ts: '1234567890.123456',
            thread_ts: '1234567890.000001',
          },
        },
      })
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
})
