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

/** Drive the real broker over HTTP so the transport talks to a genuine peer. */
async function post(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function seedTopic(
  port: number,
  session: string,
  channel: string,
  topic: string,
  texts: string[],
  spacingMs = 0,
): Promise<string> {
  await post(port, '/sessions', { name: session })
  await post(port, '/channels/join', { sessionId: session, channel })
  const created = (await (await post(port, '/topics', { topic, creator: session, channel })).json()) as { id: string }
  for (const text of texts) {
    await post(port, `/topics/${created.id}/messages`, { sender: session, text })
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
})
