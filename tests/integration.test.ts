import { describe, it, expect, vi } from 'vitest'
import { SessionManager } from '../src/session.js'
import { MessageBus } from '../src/message-bus.js'
import type { ParsedMessage } from '../src/types.js'

describe('Integration: end-to-end message flow', () => {
  it('routes inbound message through pipeline to Channel notification', async () => {
    const mockMcp = { notification: vi.fn().mockResolvedValue(undefined) }
    const bus = new MessageBus(mockMcp as never)

    const msg: ParsedMessage = {
      sender: 'carlos-backend', text: 'Need help with auth', ts: '500.100', channel: 'local',
      channelName: 'local', threadTs: 'uuid-topic',
    }
    await bus.push(msg)

    expect(mockMcp.notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Need help with auth',
        meta: {
          sender: 'carlos-backend', channel: 'local', channel_id: 'local',
          ts: '500.100', thread_ts: 'uuid-topic',
        },
      },
    })
  })

  it('session identity parsing round-trips correctly', () => {
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    const parsed = SessionManager.parse(session.fmt('hello world'))
    // fmt uses displayName (username when no role set), so sender is just 'stefan'
    expect(parsed).toEqual({ sender: 'stefan', text: 'hello world' })
  })

  it('human messages return null from parse', () => {
    expect(SessionManager.parse('just a regular message')).toBeNull()
  })
})
