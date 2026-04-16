import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SocketModeListener, type BrokerEvent } from '../src/socket-listener.js'
import { SessionManager } from '../src/session.js'
import { ActiveContext } from '../src/context.js'

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

function createMockWebClient(nameMap: Record<string, string> = {}) {
  return {
    users: {
      info: vi.fn(({ user }: { user: string }) => {
        const name = nameMap[user]
        if (name) {
          return Promise.resolve({ user: { real_name: name } })
        }
        return Promise.reject(new Error(`Unknown user ${user}`))
      }),
    },
  }
}

function makeEvent(overrides: Partial<BrokerEvent> = {}): BrokerEvent {
  return {
    channel: 'C123',
    user: null,
    text: null,
    ts: '111.000',
    thread_ts: null,
    subtype: null,
    ...overrides,
  }
}

describe('SocketModeListener', () => {
  let listener: SocketModeListener
  let mockBus: ReturnType<typeof createMockMessageBus>
  let mockSubs: ReturnType<typeof createMockSubscriptionManager>
  let mockWebClient: ReturnType<typeof createMockWebClient>

  beforeEach(() => {
    mockBus = createMockMessageBus()
    mockSubs = createMockSubscriptionManager()
    mockWebClient = createMockWebClient({ U_HUMAN: 'Stefan' })
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    const context = new ActiveContext()
    context.setChannel('C123', 'team-alpha-collab')
    context.joinTopic('111.222', 'Test topic')

    listener = new SocketModeListener({
      brokerUrl: 'http://localhost:7850',
      messageBus: mockBus as never,
      subscriptionManager: mockSubs as never,
      sessionManager: session,
      context,
      botUserId: 'U_BOT',
      selfUserId: 'U_SELF',
      webClient: mockWebClient as never,
    })
  })

  it('routes a subscribed channel message to the message bus', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: '*[carlos-backend]*: need help', ts: '111.222', user: 'U_CARLOS',
    }))
    // processEvent is sync but triggers async handleEvent - wait for microtasks
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith({
        sender: 'carlos-backend', text: 'need help', ts: '111.222', channel: 'C123',
        channelName: 'team-alpha-collab', threadTs: undefined,
      })
    })
  })

  it('includes threadTs for thread replies', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: '*[carlos-backend]*: fix', ts: '111.333', thread_ts: '111.222', user: 'U_CARLOS',
    }))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({ threadTs: '111.222' }))
    })
  })

  it('drops messages from unsubscribed channels', async () => {
    listener.processEvent(makeEvent({
      channel: 'C999', text: '*[alice]*: hello', ts: '111.444', user: 'U_ALICE',
    }))
    // Give async handler time to run
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('routes bot messages from other sessions (same bot token)', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: '*[tester]*: hello from another session', ts: '111.555', user: 'U_BOT',
    }))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'tester', text: 'hello from another session' }),
      )
    })
  })

  it('drops own session messages via isSelf', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: '*[stefan]*: my own msg', ts: '111.556', user: 'U_BOT',
    }))
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops bot system messages (no session prefix)', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: ':large_green_circle: Some topic', ts: '111.557', user: 'U_BOT',
    }))
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops own user token messages (no session prefix)', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: ':large_green_circle: My topic', ts: '111.558', user: 'U_SELF',
    }))
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops messages from threads not joined', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: '*[other]*: hello', ts: '111.559', thread_ts: '999.999', user: 'U_OTHER',
    }))
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('allows messages from joined threads', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: '*[other]*: hello', ts: '111.560', thread_ts: '111.222', user: 'U_OTHER',
    }))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'other', text: 'hello' }),
      )
    })
  })

  it('allows top-level messages (no thread_ts)', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: 'hey team status?', ts: '111.561', user: 'U_HUMAN',
    }))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalled()
    })
  })

  it('drops messages with ignored subtypes', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: 'joined', ts: '111.666', user: 'U_SOMEONE', subtype: 'channel_join',
    }))
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('handles human messages and resolves display name', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: 'hey team status?', ts: '111.777', user: 'U_HUMAN',
    }))
    await vi.waitFor(() => {
      expect(mockWebClient.users.info).toHaveBeenCalledWith({ user: 'U_HUMAN' })
      expect(mockBus.push).toHaveBeenCalledWith({
        sender: 'human:Stefan', text: 'hey team status?', ts: '111.777', channel: 'C123',
        channelName: 'team-alpha-collab', threadTs: undefined,
      })
    })
  })

  it('caches user name lookups - second message does not hit API', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: 'hello', ts: '111.888', user: 'U_HUMAN',
    }))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledTimes(1)
    })
    listener.processEvent(makeEvent({
      channel: 'C123', text: 'hello again', ts: '111.889', user: 'U_HUMAN',
    }))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledTimes(2)
    })
    expect(mockWebClient.users.info).toHaveBeenCalledTimes(1)
  })

  it('falls back to user ID when users.info fails', async () => {
    listener.processEvent(makeEvent({
      channel: 'C123', text: 'hello', ts: '111.999', user: 'U_UNKNOWN',
    }))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'human:U_UNKNOWN' }),
      )
    })
  })
})
