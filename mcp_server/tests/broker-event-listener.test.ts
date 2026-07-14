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

describe('BrokerEventListener (channel watch mode)', () => {
  let listener: BrokerEventListener
  let mockBus: ReturnType<typeof createMockMessageBus>
  let context: ActiveContext

  function messageIn(topicId: string, topicName?: string): BrokerLocalEvent {
    return {
      source: 'local',
      type: 'message',
      channel: 'default',
      topicId,
      topicName,
      sender: 'worker-1',
      text: 'PR merged',
    }
  }

  beforeEach(() => {
    mockBus = createMockMessageBus()
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    session.setName('orchestrator')
    context = new ActiveContext()

    listener = new BrokerEventListener({
      brokerUrl: 'http://localhost:7850',
      messageBus: mockBus as never,
      sessionManager: session,
      context,
    })
  })

  it('delivers a message from a topic it never joined when watching the channel', async () => {
    context.joinChannel('default', 'manual', 'local', true)
    listener.processLocalEvent(messageIn('never-joined-topic'))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({ sender: 'worker-1', text: 'PR merged', threadTs: 'never-joined-topic' }),
      )
    })
  })

  it('tags the delivered message with its topic name', async () => {
    context.joinChannel('default', 'manual', 'local', true)
    listener.processLocalEvent(messageIn('never-joined-topic', 'KAI-401'))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({ topicName: 'KAI-401' }))
    })
  })

  it('drops a message from an unjoined topic when NOT watching the channel', async () => {
    context.joinChannel('default', 'manual', 'local')
    listener.processLocalEvent(messageIn('never-joined-topic'))
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('delivers messages from topics created AFTER the session started watching', async () => {
    context.joinChannel('default', 'manual', 'local', true)
    // A topic that did not exist at watch time; the gate is per-event, so no
    // re-subscription is needed for it to be visible.
    listener.processLocalEvent(messageIn('topic-created-later'))
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({ threadTs: 'topic-created-later' }))
    })
  })

  it('does not deliver topic traffic from a channel it is not subscribed to, even while watching another', async () => {
    context.joinChannel('default', 'manual', 'local', true)
    listener.processLocalEvent({
      source: 'local',
      type: 'message',
      channel: 'other',
      topicId: 't1',
      sender: 'worker-1',
      text: 'Noise',
    })
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  // The listener only ever handles LOCAL broker events, so both of its gates
  // must ask about the LOCAL subscription. An unqualified lookup answers "is
  // ANY subscription of this name watched/subscribed?", which once remote watch
  // lands (KAI-413) would let a session watching remote "default" in org A read
  // local broker traffic of the same channel name.
  it('does not deliver local topic traffic to a session that only watches a REMOTE channel of the same name', async () => {
    context.joinChannel('default', 'manual', 'flatout', true)
    listener.processLocalEvent(messageIn('never-joined-topic'))
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('does not deliver local broadcasts to a session that is only subscribed to a REMOTE channel of the same name', async () => {
    context.joinChannel('default', 'manual', 'flatout')
    listener.processLocalEvent({
      source: 'local',
      type: 'broadcast',
      channel: 'default',
      sender: 'worker-1',
      text: 'Noise from another org',
    })
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('still drops self messages while watching', async () => {
    context.joinChannel('default', 'manual', 'local', true)
    listener.processLocalEvent({
      source: 'local',
      type: 'message',
      channel: 'default',
      topicId: 't1',
      sender: 'orchestrator',
      text: 'My own message',
    })
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('delivers topic_archived for an unjoined topic while watching', async () => {
    context.joinChannel('default', 'manual', 'local', true)
    listener.processLocalEvent({
      source: 'local',
      type: 'topic_archived',
      channel: 'default',
      topicId: 'never-joined-topic',
      archivedBy: 'worker-1',
    })
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({ text: 'Topic archived' }))
    })
  })

  // "Topic archived" against a bare uuid is unusable to a watcher: it never
  // joined the topic, so it has no local name for that id. It would know that
  // *a* topic closed, not which one — for an orchestrator whose whole use of
  // this event is "which worker just finished", that is a functional miss.
  it('names the topic in a topic_archived event so the watcher knows WHICH topic closed', async () => {
    context.joinChannel('default', 'manual', 'local', true)
    listener.processLocalEvent({
      source: 'local',
      type: 'topic_archived',
      channel: 'default',
      topicId: 'never-joined-topic',
      topicName: 'KAI-401',
      archivedBy: 'worker-1',
    })
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({ topicName: 'KAI-401' }))
    })
  })

  it('delivers and names a topic_unarchived event for an unjoined topic while watching', async () => {
    context.joinChannel('default', 'manual', 'local', true)
    listener.processLocalEvent({
      source: 'local',
      type: 'topic_unarchived',
      channel: 'default',
      topicId: 'never-joined-topic',
      topicName: 'KAI-401',
      unarchivedBy: 'worker-1',
    })
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Topic unarchived', topicName: 'KAI-401' }),
      )
    })
  })

  // The sharpest form of the opt-in guarantee: watching one channel must not
  // leak topic traffic from ANOTHER channel the session is subscribed to but
  // is NOT watching. This is what protects a worker that happens to share a
  // channel with an orchestrator.
  it('does not deliver unjoined-topic traffic from a SUBSCRIBED but unwatched channel', async () => {
    context.joinChannel('watched-ch', 'manual', 'local', true)
    context.joinChannel('quiet-ch', 'manual', 'local')
    listener.processLocalEvent({
      source: 'local',
      type: 'message',
      channel: 'quiet-ch',
      topicId: 'unjoined-in-quiet',
      sender: 'worker-1',
      text: 'should not be seen',
    })
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })
})

/**
 * `watching: true` is worthless if the stream that carries the traffic is down.
 * The listener already knows: it either holds an open SSE response or it does
 * not. These tests pin that fact to a real socket, so `whoami` can report the
 * truth instead of a subscription flag dressed up as liveness.
 */
describe('BrokerEventListener connection state (KAI-414)', () => {
  it('reports disconnected before start, connected while the SSE stream is open, disconnected after stop', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': hello\n\n')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    session.setName('orchestrator')
    const bus = createMockMessageBus()
    const listener = new BrokerEventListener({
      brokerUrl: `http://127.0.0.1:${port}`,
      messageBus: bus as never,
      sessionManager: session,
      context: new ActiveContext(),
    })

    expect(listener.isConnected()).toBe(false)
    try {
      await listener.start()
      await vi.waitFor(() => expect(listener.isConnected()).toBe(true))
      listener.stop()
      expect(listener.isConnected()).toBe(false)
    } finally {
      listener.stop()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('reports disconnected when the broker is not reachable at all', async () => {
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    session.setName('orchestrator')
    // Nothing is listening on this port: connect() fails, and the listener must
    // not pretend otherwise while it waits out the reconnect delay.
    const listener = new BrokerEventListener({
      brokerUrl: 'http://127.0.0.1:1',
      messageBus: createMockMessageBus() as never,
      sessionManager: session,
      context: new ActiveContext(),
    })
    try {
      await listener.start()
      await new Promise<void>((r) => setTimeout(r, 100))
      expect(listener.isConnected()).toBe(false)
    } finally {
      listener.stop()
    }
  })
})

/**
 * The listener half of the reconnect fix (KAI-414). A dropped SSE stream must
 * resume FROM A CURSOR (`Last-Event-ID`), so messages published during the gap
 * still arrive. And when the server says it cannot fill the gap, the listener
 * must remember that it may have missed messages — a health signal that cannot
 * say "I may have missed something" is an unsound oracle.
 */
describe('BrokerEventListener reconnect cursor (KAI-414)', () => {
  it('resumes from its cursor after a drop, so messages published during the gap still arrive', async () => {
    const delivered: string[] = []
    let connections = 0
    let resumedFrom: string | undefined

    // A stand-in broker: it drops the first connection, and on the reconnect it
    // honours Last-Event-ID by replaying what was published during the outage.
    const server = http.createServer((req, res) => {
      connections += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (connections === 1) {
        res.write(
          'id: b1:1\ndata: ' +
            JSON.stringify({
              source: 'local',
              type: 'message',
              channel: 'default',
              topicId: 't1',
              topicName: 'KAI-1',
              sender: 'worker',
              text: 'before the drop',
            }) +
            '\n\n',
        )
        setTimeout(() => res.destroy(), 30)
        return
      }
      resumedFrom = req.headers['last-event-id'] as string | undefined
      res.write(
        'id: b1:2\ndata: ' +
          JSON.stringify({
            source: 'local',
            type: 'message',
            channel: 'default',
            topicId: 't1',
            topicName: 'KAI-1',
            sender: 'worker',
            text: 'DURING the gap',
          }) +
          '\n\n',
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    session.setName('orchestrator')
    const context = new ActiveContext()
    context.joinChannel('default', 'manual', 'local', true)
    const bus = {
      push: vi.fn(async (m: { text: string }) => {
        delivered.push(m.text)
      }),
    }

    const listener = new BrokerEventListener({
      brokerUrl: `http://127.0.0.1:${port}`,
      messageBus: bus as never,
      sessionManager: session,
      context,
    })

    try {
      await listener.start()
      await vi.waitFor(() => expect(delivered).toContain('DURING the gap'), { timeout: 10_000 })
      expect(resumedFrom).toBe('b1:1')
      expect(listener.mayHaveMissedEvents()).toBe(false)
    } finally {
      listener.stop()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 15_000)

  it('admits it may have missed messages when the broker reports a gap it cannot fill', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({
            source: 'local',
            type: 'stream_gap',
            reason: 'cursor is from a previous broker instance',
          }) +
          '\n\n',
      )
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    session.setName('orchestrator')
    const bus = createMockMessageBus()
    const listener = new BrokerEventListener({
      brokerUrl: `http://127.0.0.1:${port}`,
      messageBus: bus as never,
      sessionManager: session,
      context: new ActiveContext(),
    })

    try {
      expect(listener.mayHaveMissedEvents()).toBe(false)
      await listener.start()
      await vi.waitFor(() => expect(listener.mayHaveMissedEvents()).toBe(true))
      // ...and it must TELL the session, not just remember it. An orchestrator
      // that has to run whoami to discover it went deaf is still blind.
      await vi.waitFor(() =>
        expect(bus.push).toHaveBeenCalledWith(
          expect.objectContaining({ sender: 'cccollab', text: expect.stringContaining('WARNING') }),
        ),
      )
    } finally {
      listener.stop()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, 10_000)
})
