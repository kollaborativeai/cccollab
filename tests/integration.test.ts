import { describe, it, expect, vi } from 'vitest'
import { SessionManager } from '../src/session.js'
import { SubscriptionManager } from '../src/subscriptions.js'
import { MessageBus } from '../src/message-bus.js'
import type { ParsedMessage } from '../src/types.js'

describe('Integration: end-to-end message flow', () => {
  it('routes inbound message through pipeline to Channel notification', async () => {
    const mockMcp = { notification: vi.fn().mockResolvedValue(undefined) }
    const bus = new MessageBus(mockMcp as never)

    const msg: ParsedMessage = {
      sender: 'carlos-backend', text: 'Need help with auth', ts: '500.100', channel: 'C123', threadTs: '500.001',
    }
    await bus.push(msg)

    expect(mockMcp.notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Need help with auth',
        meta: { sender: 'carlos-backend', channel: 'C123', ts: '500.100', thread_ts: '500.001' },
      },
    })
  })

  it('full subscribe -> receive -> reply flow', async () => {
    const mockMcp = { notification: vi.fn().mockResolvedValue(undefined) }
    const mockWeb = {
      conversations: {
        join: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue({ ok: true, channels: [{ id: 'C123', name: 'team-alpha-collab' }] }),
      },
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '100.200' }) },
    }
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    const subs = new SubscriptionManager(mockWeb as never)
    const bus = new MessageBus(mockMcp as never)

    await subs.join('team-alpha-collab')
    expect(subs.isSubscribed('C123')).toBe(true)

    await bus.push({ sender: 'alice-frontend', text: 'Review my PR?', ts: '600.100', channel: 'C123', threadTs: '600.001' })

    expect(mockMcp.notification).toHaveBeenCalledWith(expect.objectContaining({
      method: 'notifications/claude/channel',
      params: expect.objectContaining({ content: 'Review my PR?' }),
    }))

    await mockWeb.chat.postMessage({ channel: 'C123', thread_ts: '600.001', text: session.fmt('Sure, on it') })
    expect(mockWeb.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123', thread_ts: '600.001', text: '*[stefan-dispatcher]*: Sure, on it',
    })
  })

  it('session identity parsing round-trips correctly', () => {
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    const parsed = SessionManager.parse(session.fmt('hello world'))
    expect(parsed).toEqual({ sender: 'stefan-dispatcher', text: 'hello world' })
  })

  it('human messages return null from parse', () => {
    expect(SessionManager.parse('just a regular slack message')).toBeNull()
  })
})
