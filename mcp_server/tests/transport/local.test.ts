import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTsx } from '../../src/resolve-tsx.js'
import { LocalTransport } from '../../src/transport/local.js'

const PROFILE = `ltest-${process.pid}`
const RENDEZVOUS = join(homedir(), '.cccollab', 'run', `${PROFILE}.json`)

async function waitUntil<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return v
    await new Promise<void>((r) => setTimeout(r, 50))
  }
  throw new Error('waitUntil timeout')
}

/** Register a session the way the server does: one transport per session,
 *  holding the registration id the broker minted for it (KAI-514). */
async function registered(port: number, sessionName: string): Promise<LocalTransport> {
  const transport = new LocalTransport(port)
  await transport.introduce({ sessionName })
  return transport
}

async function seedTopic(
  port: number,
  session: string,
  channel: string,
  topic: string,
  texts: string[],
  spacingMs = 0,
): Promise<string> {
  const transport = await registered(port, session)
  await transport.joinChannel({ sessionName: session, channel })
  const created = await transport.createTopic({ sessionName: session, channel, topic })
  for (const text of texts) {
    await transport.sendTopicMessage({ sessionName: session, topicId: created.id, text })
    if (spacingMs > 0) await new Promise<void>((r) => setTimeout(r, spacingMs))
  }
  return created.id
}

describe('LocalTransport: message history reads', () => {
  let broker: ChildProcess
  let port: number

  beforeAll(async () => {
    const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
    const brokerPath = fileURLToPath(new URL('../../src/broker.ts', import.meta.url))
    broker = spawn(process.execPath, [tsxCli, brokerPath], {
      env: { ...process.env, CCCOLLAB_PROFILE: PROFILE },
      stdio: 'ignore',
    })
    await waitUntil(() => (existsSync(RENDEZVOUS) ? true : null), 10_000)
    const rendezvous = JSON.parse(readFileSync(RENDEZVOUS, 'utf-8')) as { port: number }
    port = rendezvous.port
    await waitUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
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

  describe('readChannelMessages', () => {
    it('throws "not supported" instead of returning a silent empty page', async () => {
      const transport = new LocalTransport(port)
      await expect(transport.readChannelMessages({ channel: 'anything' })).rejects.toThrow(
        /not available on the local transport/i,
      )
    })
  })

  describe('readTopicMessages', () => {
    it('returns the broker topic history mapped onto the history-page contract', async () => {
      const id = await seedTopic(port, 'lt-topic-a', 'lt-ch-a', 'lt-topic-read', ['first', 'second'])
      const transport = new LocalTransport(port)
      const page = await transport.readTopicMessages({ topicId: id })

      expect(page.messages.map((m) => m.text)).toEqual(['first', 'second'])
      // Local broker is single-tenant: sender name doubles as the session name.
      expect(page.messages.every((m) => m.sender === 'lt-topic-a' && m.senderSessionName === 'lt-topic-a')).toBe(true)
      expect(page.messages.every((m) => typeof m.ts === 'number' && Number.isFinite(m.ts))).toBe(true)
      expect(page.hasMore).toBe(false)
      expect(page.oldestTs).toBe(page.messages[0]!.ts)
    })

    it('honors limit and pages backwards with the oldestTs cursor', async () => {
      const id = await seedTopic(port, 'lt-topic-b', 'lt-ch-b', 'lt-topic-page', ['p1', 'p2', 'p3'], 2)
      const transport = new LocalTransport(port)

      const first = await transport.readTopicMessages({ topicId: id, limit: 2 })
      expect(first.messages.map((m) => m.text)).toEqual(['p2', 'p3'])
      expect(first.hasMore).toBe(true)
      expect(first.oldestTs).toBe(first.messages[0]!.ts)

      const second = await transport.readTopicMessages({ topicId: id, limit: 2, before: first.oldestTs })
      expect(second.messages.map((m) => m.text)).toEqual(['p1'])
      expect(second.hasMore).toBe(false)
    })
  })

  describe('sendSessionMessage / readSessionMessages (KAI-514)', () => {
    it('resolves the recipient id from listSessions and reports delivered:false when offline', async () => {
      await registered(port, 'lt-dm-recipient')
      const transport = await registered(port, 'lt-dm-sender')
      const sessions = await transport.listSessions({})
      const recipient = sessions.find((s) => s.name === 'lt-dm-recipient')
      expect(recipient?.id).toBeTruthy()

      const result = await transport.sendSessionMessage({
        sessionName: 'lt-dm-sender',
        toSessionId: recipient!.id!,
        text: 'hello via transport',
      })
      expect(result.delivered).toBe(false)
      expect(result.reason).toBeTruthy()
    })

    it('reports a reason (not a fallback match) for an unresolvable id', async () => {
      const transport = await registered(port, 'lt-dm-sender-2')
      const result = await transport.sendSessionMessage({
        sessionName: 'lt-dm-sender-2',
        toSessionId: 'nonexistent-id',
        text: 'hi',
      })
      expect(result.delivered).toBe(false)
      expect(result.reason).toMatch(/unknown/i)
    })

    it('round-trips a message through readSessionMessages for both parties', async () => {
      const a = await registered(port, 'lt-dm-a')
      const b = await registered(port, 'lt-dm-b')
      const sessions = await a.listSessions({})
      const bId = sessions.find((s) => s.id === b.sessionId)!.id!

      await a.sendSessionMessage({ sessionName: 'lt-dm-a', toSessionId: bId, text: 'transport dm' })

      const aId = a.sessionId!
      const asA = await a.readSessionMessages({ sessionName: 'lt-dm-a', withSessionId: bId })
      const asB = await b.readSessionMessages({ sessionName: 'lt-dm-b', withSessionId: aId })
      expect(asA.messages).toHaveLength(1)
      expect(asB.messages).toHaveLength(1)
      expect(asA.messages[0]!.text).toBe('transport dm')
      expect(asA.messages[0]!.fromName).toBe('lt-dm-a')
      // Page contract parity with every other history read: epoch-ms `ts`,
      // an `oldestTs` cursor, and `hasMore` false when the thread fits.
      expect(typeof asA.messages[0]!.ts).toBe('number')
      expect(asA.oldestTs).toBe(asA.messages[0]!.ts)
      expect(asA.hasMore).toBe(false)
    })
  })
})
