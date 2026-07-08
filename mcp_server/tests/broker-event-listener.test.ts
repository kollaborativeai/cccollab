import { describe, it, expect, vi, beforeEach } from 'vitest'
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
