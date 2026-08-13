import { describe, it, expect, vi } from 'vitest'

import { MessageBus } from '../../src/message-bus.js'
import { BrokerEventListener, type BrokerLocalEvent } from '../../src/broker-event-listener.js'
import { ActiveContext } from '../../src/context.js'
import { SessionManager } from '../../src/session.js'
import { RemoteTransport } from '../../src/transport/remote.js'
import { ensureChannelSubscription } from '../../src/transport/attach.js'
import type { ConvexClient } from 'convex/browser'

/**
 * KAI-413 parity oracle.
 *
 * The bug: on the LOCAL transport a session subscribed to a channel is told
 * when a new topic is created; on REMOTE it hears nothing. This test drives
 * the SAME scenario down BOTH transports and asserts the SAME notification
 * ARRIVES at a real second session's `MessageBus` — via one shared assertion.
 * It does not assert "an emitter was called"; it proves the message lands.
 *
 * The only fake in either arm is the transport-edge:
 *   - local arm: the broker's SSE event is handed to a real BrokerEventListener
 *     (the real receiving logic of a second session);
 *   - remote arm: the Convex socket (`onUpdate`) is stubbed — everything above
 *     it (RemoteTransport, ensureChannelSubscription wiring, MessageBus) is
 *     production code.
 */

const CHANNEL = 'product'
const TOPIC = 'Feature request: dark mode'
const CREATOR = 'sessionA'

/** Capture the MCP notifications a MessageBus emits, plus the bus itself. */
function realBus(): { bus: MessageBus; notes: Array<{ content: string; meta: Record<string, string> }> } {
  const notes: Array<{ content: string; meta: Record<string, string> }> = []
  const mcp = {
    notification: async (n: { params: { content: string; meta: Record<string, string> } }) => {
      notes.push({ content: n.params.content, meta: n.params.meta })
    },
  }
  return { bus: new MessageBus(mcp as unknown as ConstructorParameters<typeof MessageBus>[0]), notes }
}

/** The shared oracle: a topic-created notification for TOPIC by CREATOR
 *  in CHANNEL arrived at this session. Identical expectation both arms. */
function expectArrived(notes: Array<{ content: string; meta: Record<string, string> }>) {
  expect(notes).toHaveLength(1)
  expect(notes[0]!.content).toBe(`New topic in "${CHANNEL}": "${TOPIC}"`)
  expect(notes[0]!.meta.sender).toBe(CREATOR)
  expect(notes[0]!.meta.channel).toBe(CHANNEL)
}

describe('topic-created parity: local vs remote deliver the same notification to a second session', () => {
  it('LOCAL: a second session subscribed to the channel is notified', async () => {
    const { bus, notes } = realBus()

    // Session B: subscribed to the channel, no active topic, name != creator.
    const session = new SessionManager({ username: 'stefan', cwd: '/w' })
    session.setName('sessionB')
    const context = new ActiveContext()
    context.joinChannel(CHANNEL, 'manual', 'local')

    const listener = new BrokerEventListener({
      brokerUrl: 'http://localhost:0',
      messageBus: bus,
      sessionManager: session,
      context,
    })

    // The broker's real topic_created event (broker.ts fan-out shape).
    const event: BrokerLocalEvent = {
      source: 'local',
      type: 'topic_created',
      channel: CHANNEL,
      topic: { id: 'uuid-1', topic: TOPIC, channel: CHANNEL, creator: CREATOR },
    }
    listener.processLocalEvent(event)

    await vi.waitFor(() => expectArrived(notes))
  })

  it('REMOTE: a second session subscribed to the channel is notified (post-fix)', async () => {
    const { bus, notes } = realBus()

    // Stub only the Convex socket. introduce() sets sessionId 'sessionB'.
    const callbacks: Array<{ args: Record<string, unknown>; cb: (rows: unknown) => void }> = []
    const stub = {
      query: vi.fn(async () => []),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) =>
        'sessionName' in args ? 'sessionB' : undefined,
      ),
      onUpdate: vi.fn((_q: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void) => {
        callbacks.push({ args, cb })
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, source: 'remote', log: () => {} })
    await transport.introduce({ sessionName: 'sessionB' })

    // Real attach-layer wiring into the real bus.
    ensureChannelSubscription({
      transport,
      locationName: 'remote',
      channelName: CHANNEL,
      messageBus: bus,
      map: new Map<string, () => void>(),
    })

    // Find the topic-created reactive query (args carry includeArchived).
    const topicFeed = callbacks.find((c) => 'includeArchived' in c.args)
    expect(topicFeed).toBeDefined()

    // Baseline batch (empty), then the new topic appears reactively.
    topicFeed!.cb([])
    topicFeed!.cb([{ topicId: 't1', name: TOPIC, creatorSessionId: CREATOR, createdAt: 1_700_000_000_000 }])

    await vi.waitFor(() => expectArrived(notes))
  })
})
