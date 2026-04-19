import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SocketModeListener, type BrokerLocalEvent } from '../src/socket-listener.js'
import { SessionManager } from '../src/session.js'
import { ActiveContext } from '../src/context.js'

function createMockMessageBus() {
  return { push: vi.fn().mockResolvedValue(undefined) }
}

describe('SocketModeListener (local events only)', () => {
  let listener: SocketModeListener
  let mockBus: ReturnType<typeof createMockMessageBus>
  let context: ActiveContext

  beforeEach(() => {
    mockBus = createMockMessageBus()
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    session.setName('architect')
    context = new ActiveContext()
    context.joinLocalChannel()

    listener = new SocketModeListener({
      brokerUrl: 'http://localhost:7850',
      messageBus: mockBus as never,
      sessionManager: session,
      context,
    })
  })

  it('pushes topic_created events from other sessions to the bus', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_created',
      topic: { id: 'uuid-1', topic: 'Auth discussion', creator: 'tester' },
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({
        sender: 'tester',
        text: 'New local topic: "Auth discussion"',
        channel: 'local',
        channelName: 'local',
      }))
    })
  })

  it('pushes local message events for joined topics', async () => {
    context.joinTopic('uuid-topic', 'Test local', 'local')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'message',
      topicId: 'uuid-topic',
      sender: 'bob',
      text: 'Working on it',
      ts: '2026-01-01T00:00:01Z',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({
        sender: 'bob',
        text: 'Working on it',
        channel: 'local',
        threadTs: 'uuid-topic',
      }))
    })
  })

  it('drops local message events for topics not joined', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'message',
      topicId: 'uuid-not-joined',
      sender: 'bob',
      text: 'Should not see this',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops self local messages', async () => {
    context.joinTopic('uuid-self', 'Self topic', 'local')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'message',
      topicId: 'uuid-self',
      sender: 'architect',
      text: 'My own message',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('pushes topic_archived events for joined topics', async () => {
    context.joinTopic('uuid-archived', 'Archived topic', 'local')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_archived',
      topicId: 'uuid-archived',
      archivedBy: 'architect',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({
        sender: 'architect',
        text: 'Topic archived',
        channel: 'local',
        threadTs: 'uuid-archived',
      }))
    })
  })

  it('drops topic_archived events for topics not joined', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_archived',
      topicId: 'uuid-not-joined',
      archivedBy: 'architect',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('pushes topic_unarchived events for joined topics', async () => {
    context.joinTopic('uuid-unarch', 'Unarchived topic', 'local')
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_unarchived',
      topicId: 'uuid-unarch',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({
        sender: 'system',
        text: 'Topic unarchived',
        channel: 'local',
        threadTs: 'uuid-unarch',
      }))
    })
  })

  it('pushes broadcast events from other sessions to the bus', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'broadcast',
      sender: 'tester',
      text: 'Heads up everyone',
      ts: '2026-01-01T00:00:00Z',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({
        sender: 'tester',
        text: 'Heads up everyone',
        channel: 'local',
        channelName: 'local',
        threadTs: undefined,
      }))
    })
  })

  it('drops self broadcast events', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'broadcast',
      sender: 'architect',
      text: 'My own broadcast',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('delivers direct_message to intended recipient', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'direct_message',
      from: 'reviewer',
      to: 'architect',
      text: 'Got a sec?',
    }
    listener.processLocalEvent(event)
    await vi.waitFor(() => {
      expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({
        sender: 'reviewer',
        text: expect.stringContaining('Got a sec?'),
        channel: 'local',
      }))
    })
  })

  it('drops direct_message not addressed to this session', async () => {
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'direct_message',
      from: 'someone',
      to: 'someone-else',
      text: 'private',
    }
    listener.processLocalEvent(event)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(mockBus.push).not.toHaveBeenCalled()
  })
})
