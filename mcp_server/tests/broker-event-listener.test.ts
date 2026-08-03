import { describe, it, expect, vi, beforeEach } from 'vitest'
import http from 'node:http'
import { BrokerEventListener, type BrokerLocalEvent } from '../src/broker-event-listener.js'
import { SessionManager } from '../src/session.js'
import { ActiveContext } from '../src/context.js'

function createMockMessageBus() {
  return { push: vi.fn().mockResolvedValue(undefined) }
}

describe('BrokerEventListener (channel-aware)', () => {
  let listener: BrokerEventListener
  let mockBus: ReturnType<typeof createMockMessageBus>
  let context: ActiveContext

  beforeEach(() => {
    mockBus = createMockMessageBus()
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    session.setName('architect')
    context = new ActiveContext()
    context.joinChannel('default', 'fallback')

    listener = new BrokerEventListener({
      brokerUrl: 'http://localhost:7850',
      messageBus: mockBus as never,
      sessionManager: session,
      context,
    })
  })

  it('pushes topic_created events from other sessions on subscribed channel', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_created',
      channel: 'default',
      topic: { id: 'uuid-1', topic: 'Auth discussion', channel: 'default', creator: 'tester' },
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: 'tester',
          text: expect.stringContaining('Auth discussion'),
          channel: 'default',
          channelName: 'default',
        }),
      )
    })
  })

  it('drops topic_created for a channel we are not subscribed to', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_created',
      channel: 'other',
      topic: { id: 'uuid-1', topic: 'Noise', channel: 'other', creator: 'tester' },
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('pushes message events for joined topics on subscribed channel', async () => {
    context.joinTopic('uuid-topic', 'Test topic', 'default')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'message',
      channel: 'default',
      topicId: 'uuid-topic',
      sender: 'bob',
      text: 'Working on it',
      ts: '2026-01-01T00:00:01Z',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: 'bob',
          text: 'Working on it',
          channel: 'default',
          threadTs: 'uuid-topic',
        }),
      )
    })
  })

  it('drops message events for unsubscribed channel', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'message',
      channel: 'project_x',
      topicId: 'uuid-topic',
      sender: 'bob',
      text: 'Secret stuff',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops local message events for topics not joined', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'message',
      channel: 'default',
      topicId: 'uuid-not-joined',
      sender: 'bob',
      text: 'Should not see this',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops self local messages', async () => {
    context.joinTopic('uuid-self', 'Self topic', 'default')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'message',
      channel: 'default',
      topicId: 'uuid-self',
      sender: 'architect',
      text: 'My own message',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('pushes topic_archived events from a peer for joined topics on subscribed channel', async () => {
    context.joinTopic('uuid-archived', 'Archived topic', 'default')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_archived',
      channel: 'default',
      topicId: 'uuid-archived',
      archivedBy: 'peer',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: 'peer',
          text: 'Topic archived',
          channel: 'default',
          threadTs: 'uuid-archived',
        }),
      )
    })
  })

  it('drops self topic_archived so the archiver is not notified of its own action (KAI-373)', async () => {
    context.joinTopic('uuid-self-arch', 'Self archived', 'default')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_archived',
      channel: 'default',
      topicId: 'uuid-self-arch',
      archivedBy: 'architect',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('pushes topic_unarchived from a peer attributed to the unarchiver (KAI-373)', async () => {
    context.joinTopic('uuid-unarch', 'Unarchived', 'default')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_unarchived',
      channel: 'default',
      topicId: 'uuid-unarch',
      unarchivedBy: 'peer',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: 'peer',
          text: 'Topic unarchived',
          channel: 'default',
          threadTs: 'uuid-unarch',
        }),
      )
    })
  })

  it('drops self topic_unarchived so the unarchiver is not notified of its own action (KAI-373)', async () => {
    context.joinTopic('uuid-self-unarch', 'Self unarchived', 'default')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_unarchived',
      channel: 'default',
      topicId: 'uuid-self-unarch',
      unarchivedBy: 'architect',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('pushes broadcast events from other sessions on subscribed channel', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'broadcast',
      channel: 'default',
      sender: 'tester',
      text: 'Heads up everyone',
      ts: '2026-01-01T00:00:00Z',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: 'tester',
          text: 'Heads up everyone',
          channel: 'default',
          channelName: 'default',
          threadTs: undefined,
        }),
      )
    })
  })

  it('drops broadcast for unsubscribed channel', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'broadcast',
      channel: 'not_subscribed',
      sender: 'tester',
      text: 'Noise',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops self broadcast events', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'broadcast',
      channel: 'default',
      sender: 'architect',
      text: 'My own broadcast',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })
})

/**
 * KAI-446: the broker now only streams a channel-tagged event to a connection
 * whose session is subscribed to that channel, so the listener has to say who
 * it is. It connects before `introduce` has run, so it must also re-open once
 * the session acquires a name — otherwise a session that introduces itself
 * after startup stays anonymous on the broker and silently receives nothing.
 */
describe('BrokerEventListener: identifying the stream (KAI-446)', () => {
  /** Records the paths the listener requests, and holds every connection open
   *  so a reconnect is observable as a second request rather than a retry. */
  async function stubBroker(): Promise<{
    url: string
    paths: string[]
    liveConnections: () => number
    close: () => Promise<void>
  }> {
    const paths: string[] = []
    const open = new Set<import('node:http').ServerResponse>()
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders()
      open.add(res)
      req.on('close', () => open.delete(res))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as import('node:net').AddressInfo
    return {
      url: `http://127.0.0.1:${port}`,
      paths,
      liveConnections: () => open.size,
      close: () =>
        new Promise<void>((r) => {
          for (const res of open) res.end()
          server.close(() => r())
        }),
    }
  }

  function build(broker: { url: string }, name?: string) {
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    if (name) session.setName(name)
    const context = new ActiveContext()
    const listener = new BrokerEventListener({
      brokerUrl: broker.url,
      messageBus: createMockMessageBus() as never,
      sessionManager: session,
      context,
    })
    return { listener, session }
  }

  it('names the session in the connect URL so the broker can scope the stream', async () => {
    const broker = await stubBroker()
    const { listener } = build(broker, 'architect')
    try {
      await listener.start()
      await vi.waitFor(() => expect(broker.paths.length).toBe(1))
      expect(broker.paths[0]).toBe('/events?sessionId=architect')
    } finally {
      listener.stop()
      await broker.close()
    }
  })

  it('percent-encodes a session name that is not URL-safe', async () => {
    const broker = await stubBroker()
    const { listener } = build(broker, 'front end & api')
    try {
      await listener.start()
      await vi.waitFor(() => expect(broker.paths.length).toBe(1))
      expect(broker.paths[0]).toBe('/events?sessionId=front%20end%20%26%20api')
    } finally {
      listener.stop()
      await broker.close()
    }
  })

  it('connects anonymously while the session has no name', async () => {
    const broker = await stubBroker()
    const { listener } = build(broker)
    try {
      await listener.start()
      await vi.waitFor(() => expect(broker.paths.length).toBe(1))
      expect(broker.paths[0]).toBe('/events')
    } finally {
      listener.stop()
      await broker.close()
    }
  })

  it('re-opens the stream under the new name once the session introduces itself', async () => {
    const broker = await stubBroker()
    const { listener, session } = build(broker)
    try {
      await listener.start()
      await vi.waitFor(() => expect(broker.paths.length).toBe(1))
      expect(broker.paths[0]).toBe('/events')

      session.setName('architect')
      listener.reconnectForIdentity()

      await vi.waitFor(() => expect(broker.paths.length).toBe(2))
      expect(broker.paths[1]).toBe('/events?sessionId=architect')
    } finally {
      listener.stop()
      await broker.close()
    }
  })

  /**
   * Tearing down the old request fires the same 'end'/'error' path a dropped
   * broker connection does, which schedules a retry. Without a guard that retry
   * lands ~2s later on top of the identified stream and the session ends up
   * with two live connections, double-delivering every event.
   */
  it('does not leave the superseded connection reconnecting in parallel', async () => {
    const broker = await stubBroker()
    const { listener, session } = build(broker)
    try {
      await listener.start()
      await vi.waitFor(() => expect(broker.paths.length).toBe(1))

      session.setName('architect')
      listener.reconnectForIdentity()
      await vi.waitFor(() => expect(broker.paths.length).toBe(2))

      // Past the reconnect delay: the orphaned request must not have retried.
      await new Promise<void>((r) => setTimeout(r, 2600))
      expect(broker.paths).toEqual(['/events', '/events?sessionId=architect'])
      expect(broker.liveConnections()).toBe(1)
    } finally {
      listener.stop()
      await broker.close()
    }
  }, 10_000)

  it('stays put when reconnectForIdentity is called with no name yet', async () => {
    const broker = await stubBroker()
    const { listener } = build(broker)
    try {
      await listener.start()
      await vi.waitFor(() => expect(broker.paths.length).toBe(1))
      listener.reconnectForIdentity()
      await new Promise<void>((r) => setTimeout(r, 150))
      expect(broker.paths).toEqual(['/events'])
    } finally {
      listener.stop()
      await broker.close()
    }
  })
})
