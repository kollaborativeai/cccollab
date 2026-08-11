import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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

  describe('listSessions', () => {
    it('flags the row for the session this transport introduced, and no other', async () => {
      // A transport is the only authority on which row is its own: it holds
      // the identity its own `introduce` established. The tool layer needs
      // that flag to merge one process's registrations across locations
      // without guessing from display names.
      await post(port, '/sessions', { name: 'lt-sess-peer' })
      await post(port, '/channels/join', { sessionId: 'lt-sess-peer', channel: 'lt-ch-sessions' })

      const transport = new LocalTransport(port)
      await transport.introduce({ sessionName: 'lt-sess-own' })
      await transport.joinChannel({ sessionName: 'lt-sess-own', channel: 'lt-ch-sessions' })

      const rows = await transport.listSessions({ channel: 'lt-ch-sessions' })
      expect(rows.map((s) => [s.name, s.self === true])).toEqual(
        expect.arrayContaining([
          ['lt-sess-own', true],
          ['lt-sess-peer', false],
        ]),
      )
    })

    it('flags nothing before introduce — an un-introduced transport has no own row', async () => {
      await post(port, '/sessions', { name: 'lt-sess-other' })
      await post(port, '/channels/join', { sessionId: 'lt-sess-other', channel: 'lt-ch-anon' })

      const rows = await new LocalTransport(port).listSessions({ channel: 'lt-ch-anon' })
      expect(rows).not.toHaveLength(0)
      expect(rows.some((s) => s.self === true)).toBe(false)
    })

    // C2 (KAI-516 review): the only assignment to `ownSessionName` used to
    // sit AFTER the awaited POST, and both `introduce` call sites swallow
    // the throw (server.ts's startup introduce, tools/identity.ts's fan-out).
    // The broker meanwhile creates the row implicitly on join, so it holds a
    // row that IS ours which this transport would never flag — a phantom
    // second peer for one process, for the life of that process.
    it('C2: flags its own row after a FAILED introduce, once a later join creates the row', async () => {
      const realFetch = globalThis.fetch
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/sessions') && init?.method === 'POST') {
          throw new Error('broker unreachable at startup')
        }
        return realFetch(input, init)
      })
      const transport = new LocalTransport(port)
      await expect(transport.introduce({ sessionName: 'lt-sess-c2' })).rejects.toThrow(/broker unreachable/)
      vi.unstubAllGlobals()

      // What server.ts does next regardless: auto-join. The broker's
      // ensureSession() materialises the row here.
      await transport.joinChannel({ sessionName: 'lt-sess-c2', channel: 'lt-ch-c2' })

      const rows = await transport.listSessions({ channel: 'lt-ch-c2' })
      expect(rows.map((s) => s.name)).toContain('lt-sess-c2')
      expect(rows.find((s) => s.name === 'lt-sess-c2')?.self).toBe(true)
    })

    // The same hole reached the other way: `session.displayName` falls back
    // to the username, and server.ts only introduces when `hasName()`. An
    // un-named session that auto-joins a configured channel therefore
    // registers with the broker without any introduce at all.
    it('C2: adopts the name a channel join registers when introduce never ran', async () => {
      const transport = new LocalTransport(port)
      await transport.joinChannel({ sessionName: 'lt-sess-c2-nointro', channel: 'lt-ch-c2-nointro' })

      const rows = await transport.listSessions({ channel: 'lt-ch-c2-nointro' })
      expect(rows.find((s) => s.name === 'lt-sess-c2-nointro')?.self).toBe(true)
    })
  })

  // I3 (KAI-516 review): server.ts swallows the startup introduce, and this
  // PR made `self` depend on it. A failure there must be visible somewhere —
  // `whoami` reads this getter off every transport in the router.
  describe('degradation', () => {
    it('I3: reports a failed introduce, and clears it once one succeeds', async () => {
      const transport = new LocalTransport(port)
      expect(transport.degradation).toBeNull()

      const realFetch = globalThis.fetch
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/sessions') && init?.method === 'POST') {
          throw new Error('broker unreachable at startup')
        }
        return realFetch(input, init)
      })
      await expect(transport.introduce({ sessionName: 'lt-sess-i3' })).rejects.toThrow()
      vi.unstubAllGlobals()

      expect(transport.degradation).toMatch(/introduce failed/i)

      await transport.introduce({ sessionName: 'lt-sess-i3' })
      expect(transport.degradation).toBeNull()
    })
  })
})
