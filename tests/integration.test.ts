import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { SessionManager } from '../src/session.js'
import { MessageBus } from '../src/message-bus.js'
import { ActiveContext } from '../src/context.js'
import { BrokerEventListener } from '../src/broker-event-listener.js'
import { handleIdentityTool } from '../src/tools/identity.js'
import { handleChannelTool } from '../src/tools/channels.js'
import { handleTopicTool } from '../src/tools/topics.js'
import type { ParsedMessage } from '../src/types.js'

const BROKER_ID = `itest-${process.pid}`
const RENDEZVOUS = `/tmp/cccollab-broker-${BROKER_ID}.json`

async function waitUntil<T>(fn: () => T | null, timeoutMs = 5000, intervalMs = 50): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = fn()
    if (v) return v
    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }
  throw new Error('waitUntil timeout')
}

interface SessionHarness {
  name: string
  displayName: string
  session: SessionManager
  context: ActiveContext
  listener: BrokerEventListener
  received: ParsedMessage[]
  identityDeps: { session: SessionManager; context: ActiveContext; brokerPort: number }
  channelDeps: { session: SessionManager; context: ActiveContext; brokerPort: number }
  topicDeps: { session: SessionManager; context: ActiveContext; brokerPort: number }
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

  const deps = { session, context, brokerPort }
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
      sender: 'carlos-backend', text: 'Need help with auth', ts: '500.100', channel: 'default',
      channelName: 'default', threadTs: 'uuid-topic',
    }
    await bus.push(msg)

    expect(mockMcp.notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Need help with auth',
        meta: {
          sender: 'carlos-backend', channel: 'default', channel_id: 'default',
          ts: '500.100', thread_ts: 'uuid-topic',
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
    const tsx = new URL('../node_modules/.bin/tsx', import.meta.url).pathname
    const brokerPath = new URL('../src/broker.ts', import.meta.url).pathname
    broker = spawn(tsx, [brokerPath], {
      env: { ...process.env, BROKER_ID },
      stdio: 'ignore',
    })
    await waitUntil(() => existsSync(RENDEZVOUS) ? true : null, 10_000)
    const rendezvous = JSON.parse(readFileSync(RENDEZVOUS, 'utf-8')) as { port: number }
    brokerPort = rendezvous.port
    await waitUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${brokerPort}/health`)
        return res.ok ? true : null
      } catch { return null }
    }, 10_000)
  }, 20_000)

  afterAll(async () => {
    if (broker && !broker.killed) {
      broker.kill('SIGTERM')
      await new Promise<void>((r) => setTimeout(r, 200))
      try { unlinkSync(RENDEZVOUS) } catch { /* ignore */ }
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

      const dmResult = await handleTopicTool(
        'send_message_to_session',
        { to: 'b-project-x', text: 'ping' },
        A.topicDeps,
      )
      expect(dmResult).toContain('sent')

      await waitUntil(() => (B.received.length > 0 ? true : null), 3000)
      expect(B.received.some((m) => m.text.includes('ping'))).toBe(true)

      A.received.length = 0
      B.received.length = 0
      C.received.length = 0

      await handleChannelTool('leave_channel', { name: 'ai_instructions' }, A.channelDeps)
      const dmResult2 = await handleTopicTool(
        'send_message_to_session',
        { to: 'b-project-x', text: 'should fail' },
        A.topicDeps,
      )
      expect(dmResult2).toContain('do not share')
      expect(B.received.some((m) => m.text.includes('should fail'))).toBe(false)
    } finally {
      A.listener.stop()
      B.listener.stop()
      C.listener.stop()
    }
  }, 15_000)
})
