import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTsx } from '../src/resolve-tsx.js'
import { SessionManager } from '../src/session.js'
import { MessageBus } from '../src/message-bus.js'
import { ActiveContext } from '../src/context.js'
import { BrokerEventListener } from '../src/broker-event-listener.js'
import { LocalTransport } from '../src/transport/local.js'
import { TransportRouter } from '../src/transport/router.js'
import { handleIdentityTool } from '../src/tools/identity.js'
import { handleChannelTool } from '../src/tools/channels.js'
import { handleTopicTool } from '../src/tools/topics.js'
import type { ParsedMessage } from '../src/types.js'

const PROFILE = `itest-${process.pid}`
const RENDEZVOUS = join(homedir(), '.cccollab', 'run', `${PROFILE}.json`)

async function waitUntil<T>(fn: () => T | null, timeoutMs = 5000, intervalMs = 50): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }
  throw new Error('waitUntil timeout')
}

interface HarnessDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
}

interface SessionHarness {
  name: string
  displayName: string
  session: SessionManager
  context: ActiveContext
  listener: BrokerEventListener
  received: ParsedMessage[]
  identityDeps: HarnessDeps
  channelDeps: HarnessDeps
  topicDeps: HarnessDeps
}

async function makeSession(displayName: string, brokerPort: number): Promise<SessionHarness> {
  const session = new SessionManager({ username: 'tester', cwd: `/projects/${displayName}` })
  const context = new ActiveContext()
  const received: ParsedMessage[] = []
  const messageBus = new MessageBus({
    notification: vi.fn().mockResolvedValue(undefined),
  } as never)
  messageBus.push = vi.fn(async (m: ParsedMessage) => {
    received.push(m)
  })

  const listener = new BrokerEventListener({
    brokerUrl: `http://127.0.0.1:${brokerPort}`,
    messageBus,
    sessionManager: session,
    context,
  })
  await listener.start()

  const transport = new LocalTransport(brokerPort)
  const router = new TransportRouter([transport])
  const deps: HarnessDeps = { session, context, router }
  await handleIdentityTool('introduce', { name: displayName }, deps)

  return {
    name: displayName,
    displayName,
    session,
    context,
    listener,
    received,
    identityDeps: deps,
    channelDeps: deps,
    topicDeps: deps,
  }
}

describe('Integration: end-to-end message flow', () => {
  it('routes inbound message through pipeline to Channel notification', async () => {
    const mockMcp = { notification: vi.fn().mockResolvedValue(undefined) }
    const bus = new MessageBus(mockMcp as never)

    const msg: ParsedMessage = {
      sender: 'carlos-backend',
      text: 'Need help with auth',
      ts: '500.100',
      channel: 'default',
      channelName: 'default',
      threadTs: 'uuid-topic',
    }
    await bus.push(msg)

    expect(mockMcp.notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Need help with auth',
        meta: {
          sender: 'carlos-backend',
          channel: 'default',
          channel_id: 'default',
          ts: '500.100',
          thread_ts: 'uuid-topic',
          source: 'local',
        },
      },
    })
  })

  it('session identity parsing round-trips correctly', () => {
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    const parsed = SessionManager.parse(session.fmt('hello world'))
    expect(parsed).toEqual({ sender: 'stefan', text: 'hello world' })
  })

  it('human messages return null from parse', () => {
    expect(SessionManager.parse('just a regular message')).toBeNull()
  })
})

describe('Integration: multi-channel subscriptions (CCC-26)', () => {
  let broker: ChildProcess
  let brokerPort: number

  beforeAll(async () => {
    const tsx = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsx) throw new Error('tsx binary not found on any ancestor')
    const brokerPath = new URL('../src/broker.ts', import.meta.url).pathname
    broker = spawn(tsx, [brokerPath], {
      env: { ...process.env, CCCOLLAB_PROFILE: PROFILE },
      stdio: 'ignore',
    })
    await waitUntil(() => (existsSync(RENDEZVOUS) ? true : null), 10_000)
    const rendezvous = JSON.parse(readFileSync(RENDEZVOUS, 'utf-8')) as { port: number }
    brokerPort = rendezvous.port
    await waitUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${brokerPort}/health`)
        return res.ok ? true : null
      } catch {
        return null
      }
    }, 10_000)
  }, 20_000)

  afterAll(async () => {
    if (broker && !broker.killed) {
      broker.kill('SIGTERM')
      await new Promise<void>((r) => setTimeout(r, 200))
      try {
        unlinkSync(RENDEZVOUS)
      } catch {
        /* ignore */
      }
    }
  })

  it('AI-maintainer scenario: channels scope broadcasts; DMs need shared channel', async () => {
    const A = await makeSession('a-maintainer', brokerPort)
    const B = await makeSession('b-project-x', brokerPort)
    const C = await makeSession('c-project-y', brokerPort)

    try {
      await handleChannelTool('join_channel', { name: 'ai_instructions' }, A.channelDeps)

      await handleChannelTool('join_channel', { name: 'project_x' }, B.channelDeps)
      await handleChannelTool('join_channel', { name: 'ai_instructions' }, B.channelDeps)

      await handleChannelTool('join_channel', { name: 'project_y' }, C.channelDeps)
      await handleChannelTool('join_channel', { name: 'ai_instructions' }, C.channelDeps)

      A.received.length = 0
      B.received.length = 0
      C.received.length = 0

      await handleChannelTool(
        'send_message_to_channel',
        { text: 'Hey maintainers', channel: 'ai_instructions' },
        B.channelDeps,
      )

      await waitUntil(() => (A.received.length > 0 && C.received.length > 0 ? true : null), 3000)
      expect(A.received.some((m) => m.text === 'Hey maintainers' && m.channel === 'ai_instructions')).toBe(true)
      expect(C.received.some((m) => m.text === 'Hey maintainers' && m.channel === 'ai_instructions')).toBe(true)
      expect(B.received.some((m) => m.text === 'Hey maintainers')).toBe(false)

      A.received.length = 0
      B.received.length = 0
      C.received.length = 0

      await handleChannelTool(
        'send_message_to_channel',
        { text: 'Project X only', channel: 'project_x' },
        B.channelDeps,
      )

      await new Promise<void>((r) => setTimeout(r, 300))
      expect(A.received.some((m) => m.text === 'Project X only')).toBe(false)
      expect(C.received.some((m) => m.text === 'Project X only')).toBe(false)

      A.received.length = 0
      B.received.length = 0
      C.received.length = 0

      const dmResult = JSON.parse(
        await handleTopicTool('send_message_to_session', { to: 'b-project-x', text: 'ping' }, A.topicDeps),
      )
      expect(dmResult.to).toBe('b-project-x')

      await waitUntil(() => (B.received.length > 0 ? true : null), 3000)
      expect(B.received.some((m) => m.text.includes('ping'))).toBe(true)

      A.received.length = 0
      B.received.length = 0
      C.received.length = 0

      await handleChannelTool('leave_channel', { name: 'ai_instructions' }, A.channelDeps)
      const dmResult2 = JSON.parse(
        await handleTopicTool('send_message_to_session', { to: 'b-project-x', text: 'should fail' }, A.topicDeps),
      )
      expect(dmResult2.error).toContain('do not share')
      expect(B.received.some((m) => m.text.includes('should fail'))).toBe(false)
    } finally {
      A.listener.stop()
      B.listener.stop()
      C.listener.stop()
    }
  }, 15_000)

  it('leave_channel cascades: broker drops session from topics in that channel', async () => {
    const A = await makeSession('cascade-a', brokerPort)
    const B = await makeSession('cascade-b', brokerPort)
    try {
      await handleChannelTool('join_channel', { name: 'cascade-ch' }, A.channelDeps)
      await handleChannelTool('join_channel', { name: 'cascade-ch' }, B.channelDeps)

      const started = JSON.parse(await handleTopicTool('start_topic', { topic: 'cascade-topic' }, A.topicDeps))
      const topicId = started.id as string

      await handleTopicTool('join_topic', { topic: 'cascade-topic' }, B.topicDeps)

      // Sanity: broker knows B joined the topic
      const before = (await (
        await fetch(`http://127.0.0.1:${brokerPort}/topics/${topicId}?sessionId=cascade-a`)
      ).json()) as {
        topic: { id: string }
      }
      expect(before.topic.id).toBe(topicId)

      await handleChannelTool('leave_channel', { name: 'cascade-ch' }, B.channelDeps)

      // After leave, a fresh join on B should be refused by the broker because B is no longer subscribed
      const rejoin = await fetch(`http://127.0.0.1:${brokerPort}/topics/${topicId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'cascade-b' }),
      })
      expect(rejoin.status).toBe(403)

      // Sending a message to the topic from B is also refused
      const sendAttempt = await fetch(`http://127.0.0.1:${brokerPort}/topics/${topicId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: 'cascade-b', text: 'should not send' }),
      })
      expect(sendAttempt.status).toBe(403)
    } finally {
      A.listener.stop()
      B.listener.stop()
    }
  }, 15_000)

  it('GET /topics/{id} requires sessionId and refuses non-subscribed callers', async () => {
    const A = await makeSession('gate-a', brokerPort)
    const B = await makeSession('gate-b', brokerPort)
    try {
      await handleChannelTool('join_channel', { name: 'gate-ch' }, A.channelDeps)
      await handleChannelTool('join_channel', { name: 'other-ch' }, B.channelDeps)

      const started = JSON.parse(await handleTopicTool('start_topic', { topic: 'gated-topic' }, A.topicDeps))
      const topicId = started.id as string

      // No sessionId -> 400
      const noSession = await fetch(`http://127.0.0.1:${brokerPort}/topics/${topicId}`)
      expect(noSession.status).toBe(400)

      // Subscribed -> 200
      const okRes = await fetch(`http://127.0.0.1:${brokerPort}/topics/${topicId}?sessionId=gate-a`)
      expect(okRes.status).toBe(200)

      // Not subscribed to the topic's channel -> 403
      const forbidden = await fetch(`http://127.0.0.1:${brokerPort}/topics/${topicId}?sessionId=gate-b`)
      expect(forbidden.status).toBe(403)
      const body = (await forbidden.json()) as { error: string }
      expect(body.error).toContain('Not subscribed')
    } finally {
      A.listener.stop()
      B.listener.stop()
    }
  }, 15_000)

  /**
   * Two-session acceptance-criterion scenario expressed as an
   * integration test: two independent MCP-tool-surface harnesses share
   * one broker, go through introduce -> join_channel -> start_topic ->
   * join_topic -> send_message_to_topic, and the receiving session
   * observes the message via its MessageBus stub. This is the
   * equivalent of running `./test/start.sh left` and `./test/start.sh
   * right` by hand: both sessions coordinate through the same broker
   * and a topic message sent by one is picked up by the other.
   */
  it('two sessions share a topic and exchange a message end-to-end', async () => {
    const LEFT = await makeSession('two-session-left', brokerPort)
    const RIGHT = await makeSession('two-session-right', brokerPort)
    try {
      // Both join the same channel so the topic is reachable from both
      // sides. The broker scopes topic visibility by channel membership.
      await handleChannelTool('join_channel', { name: 'cccollab-test' }, LEFT.channelDeps)
      await handleChannelTool('join_channel', { name: 'cccollab-test' }, RIGHT.channelDeps)

      // LEFT creates the topic, RIGHT joins it by name.
      const started = JSON.parse(
        await handleTopicTool('start_topic', { topic: 'two-session-topic', channel: 'cccollab-test' }, LEFT.topicDeps),
      )
      const topicId = started.id as string
      expect(started.name).toBe('two-session-topic')

      await handleTopicTool('join_topic', { topic: 'two-session-topic' }, RIGHT.topicDeps)

      LEFT.received.length = 0
      RIGHT.received.length = 0

      // LEFT sends; RIGHT must observe the message via the broker's
      // topic fan-out and the SSE listener that feeds MessageBus.
      await handleTopicTool(
        'send_message_to_topic',
        { text: 'hello from left', topic: 'two-session-topic' },
        LEFT.topicDeps,
      )

      await waitUntil(
        () => (RIGHT.received.some((m) => m.text === 'hello from left' && m.threadTs === topicId) ? true : null),
        3000,
      )
      // Exactly the message we sent, attributed to the correct topic.
      const match = RIGHT.received.find((m) => m.text === 'hello from left')
      expect(match).toBeDefined()
      expect(match?.threadTs).toBe(topicId)
      expect(match?.channel).toBe('cccollab-test')
    } finally {
      LEFT.listener.stop()
      RIGHT.listener.stop()
    }
  }, 15_000)
})
