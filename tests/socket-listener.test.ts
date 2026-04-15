import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SocketModeListener } from '../src/socket-listener.js'
import { SessionManager } from '../src/session.js'

function createMockSocketModeClient() {
  const handlers = new Map<string, Function>()
  return {
    on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler) }),
    start: vi.fn().mockResolvedValue(undefined),
    _trigger: (event: string, payload: unknown) => {
      const handler = handlers.get(event)
      if (handler) handler(payload)
    },
  }
}

function createMockMessageBus() {
  return { push: vi.fn().mockResolvedValue(undefined) }
}

function createMockSubscriptionManager() {
  const subscribed = new Set<string>(['C123'])
  return {
    isSubscribed: vi.fn((id: string) => subscribed.has(id)),
    getChannelName: vi.fn((id: string) => (id === 'C123' ? 'team-alpha-collab' : undefined)),
  }
}

describe('SocketModeListener', () => {
  let listener: SocketModeListener
  let mockSocket: ReturnType<typeof createMockSocketModeClient>
  let mockBus: ReturnType<typeof createMockMessageBus>
  let mockSubs: ReturnType<typeof createMockSubscriptionManager>

  beforeEach(() => {
    mockSocket = createMockSocketModeClient()
    mockBus = createMockMessageBus()
    mockSubs = createMockSubscriptionManager()
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })

    listener = new SocketModeListener({
      socketClient: mockSocket as never,
      messageBus: mockBus as never,
      subscriptionManager: mockSubs as never,
      sessionManager: session,
      botUserId: 'U_BOT',
    })
  })

  it('registers message handler on construction', () => {
    expect(mockSocket.on).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('starts the socket mode client', async () => {
    await listener.start()
    expect(mockSocket.start).toHaveBeenCalled()
  })

  it('routes a subscribed channel message to the message bus', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C123', text: '*[carlos-backend]*: need help', ts: '111.222', user: 'U_CARLOS' },
    })
    expect(mockBus.push).toHaveBeenCalledWith({
      sender: 'carlos-backend', text: 'need help', ts: '111.222', channel: 'C123', threadTs: undefined,
    })
  })

  it('includes threadTs for thread replies', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C123', text: '*[carlos-backend]*: fix', ts: '111.333', thread_ts: '111.222', user: 'U_CARLOS' },
    })
    expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({ threadTs: '111.222' }))
  })

  it('drops messages from unsubscribed channels', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C999', text: '*[alice]*: hello', ts: '111.444', user: 'U_ALICE' },
    })
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops self-messages by bot user ID', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C123', text: '*[stefan-dispatcher]*: my msg', ts: '111.555', user: 'U_BOT' },
    })
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops messages with subtypes', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', subtype: 'channel_join', channel: 'C123', text: 'joined', ts: '111.666', user: 'U_SOMEONE' },
    })
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('handles human messages (no session prefix)', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C123', text: 'hey team status?', ts: '111.777', user: 'U_HUMAN' },
    })
    expect(mockBus.push).toHaveBeenCalledWith({
      sender: 'human:U_HUMAN', text: 'hey team status?', ts: '111.777', channel: 'C123', threadTs: undefined,
    })
  })
})
