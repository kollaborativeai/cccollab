import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTsx } from '../src/resolve-tsx.js'

const PROFILE = `bdmtest-${process.pid}`
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

async function registerSession(port: number, name: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; id: string }
  return body.id
}

async function sendDm(port: number, toId: string, from: string, text: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(toId)}/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, text }),
  })
}

interface DmPage {
  messages: Array<{ fromId: string; fromName: string; text: string; ts: number }>
  hasMore: boolean
}

async function readDmPage(
  port: number,
  withId: string,
  asName: string,
  opts: { limit?: number; before?: number } = {},
): Promise<DmPage> {
  const params = new URLSearchParams({ asName })
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.before !== undefined) params.set('before', String(opts.before))
  const res = await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(withId)}/dm?${params.toString()}`)
  return (await res.json()) as DmPage
}

async function readDm(
  port: number,
  withId: string,
  asName: string,
): Promise<Array<{ fromId: string; fromName: string; text: string; ts: number }>> {
  return (await readDmPage(port, withId, asName)).messages
}

/** Opens an SSE stream (tagged with a sessionId, or untagged) and keeps it
 *  open, collecting every event into `events`. Returns a `close()` to tear
 *  it down. Used to assert a connection does NOT receive a message over a
 *  window. */
function openStream(
  port: number,
  sessionId: string | undefined,
): { events: Array<Record<string, unknown>>; close: () => void } {
  const events: Array<Record<string, unknown>> = []
  const path = sessionId ? `/events?sessionId=${encodeURIComponent(sessionId)}` : '/events'
  const req = http.get(
    {
      host: '127.0.0.1',
      port,
      path,
      headers: { Accept: 'text/event-stream' },
    },
    (res) => {
      res.setEncoding('utf-8')
      let buffer = ''
      res.on('data', (chunk: string) => {
        buffer += chunk
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          try {
            events.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
          } catch {
            /* keepalive */
          }
        }
      })
    },
  )
  req.on('error', () => {
    /* torn down */
  })
  return { events, close: () => req.destroy() }
}

async function deleteSession(port: number, name: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

/** Opens the broker's SSE stream tagged to a sessionId, resolving once a
 *  matching event arrives (or timing out with null). Mirrors the pattern in
 *  broker.test.ts / local.test.ts. */
function nextEventFor(
  port: number,
  sessionId: string,
  predicate: (evt: Record<string, unknown>) => boolean,
  onConnected: () => Promise<void>,
  timeoutMs = 4000,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: `/events?sessionId=${encodeURIComponent(sessionId)}`,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        res.setEncoding('utf-8')
        let buffer = ''
        res.on('data', (chunk: string) => {
          buffer += chunk
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data:'))
            if (!line) continue
            try {
              const evt = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
              if (predicate(evt)) finish(evt)
            } catch {
              /* keepalive / non-JSON frame */
            }
          }
        })
        onConnected().catch(reject)
      },
    )
    req.on('error', reject)
  })
}

describe('Broker: direct messages (send_message_to_session)', () => {
  let broker: ChildProcess
  let port: number

  beforeAll(async () => {
    const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
    const brokerPath = fileURLToPath(new URL('../src/broker.ts', import.meta.url))
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

  it('registration returns a stable id, distinct across two different names', async () => {
    const idA = await registerSession(port, 'dm-reg-a')
    const idB = await registerSession(port, 'dm-reg-b')
    expect(idA).toBeTruthy()
    expect(idB).toBeTruthy()
    expect(idA).not.toBe(idB)
  })

  it('re-introducing the same still-registered session keeps the same id', async () => {
    const first = await registerSession(port, 'dm-reg-stable')
    const second = await registerSession(port, 'dm-reg-stable')
    expect(second).toBe(first)
  })

  it('rejects a self-send', async () => {
    const id = await registerSession(port, 'dm-self')
    const res = await sendDm(port, id, 'dm-self', 'talking to myself')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/yourself/i)
  })

  it('reports delivered:false with a reason for an unknown recipient id, never falling back to name matching', async () => {
    await registerSession(port, 'dm-from-unknown-target')
    const res = await sendDm(port, 'not-a-real-id', 'dm-from-unknown-target', 'hello?')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: boolean; reason?: string }
    expect(body.delivered).toBe(false)
    expect(body.reason).toBeTruthy()
  })

  it('reports delivered:false when the recipient has no open SSE connection', async () => {
    const senderName = 'dm-sender-offline'
    const recipientId = await registerSession(port, 'dm-recipient-offline')
    await registerSession(port, senderName)
    const res = await sendDm(port, recipientId, senderName, 'are you there?')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: boolean; reason?: string }
    expect(body.delivered).toBe(false)
    expect(body.reason).toMatch(/attached|connect/i)
  })

  it('reports delivered:true and wakes the recipient when its SSE connection is open', async () => {
    const senderName = 'dm-sender-online'
    const recipientName = 'dm-recipient-online'
    const recipientId = await registerSession(port, recipientName)
    await registerSession(port, senderName)

    const evtPromise = nextEventFor(
      port,
      recipientName,
      (evt) => evt.type === 'dm' && evt.fromName === senderName,
      async () => {
        const res = await sendDm(port, recipientId, senderName, 'hi there')
        expect(res.status).toBe(200)
        const body = (await res.json()) as { delivered: boolean }
        expect(body.delivered).toBe(true)
      },
    )
    const evt = await evtPromise
    expect(evt).not.toBeNull()
    expect(evt!.text).toBe('hi there')
  })

  it('lets both parties read the exchange back, and keeps it out of the unrelated-session view', async () => {
    const aName = 'dm-hist-a'
    const bName = 'dm-hist-b'
    const aId = await registerSession(port, aName)
    const bId = await registerSession(port, bName)
    await sendDm(port, bId, aName, 'first message')

    const asA = await readDm(port, bId, aName)
    const asB = await readDm(port, aId, bName)
    expect(asA).toHaveLength(1)
    expect(asB).toHaveLength(1)
    expect(asA[0]!.text).toBe('first message')
    expect(asA[0]!.fromName).toBe(aName)

    const outsiderId = await registerSession(port, 'dm-hist-outsider')
    const asOutsider = await readDm(port, aId, 'dm-hist-outsider')
    expect(asOutsider).toHaveLength(0)
    void outsiderId
  })

  it('pages a long thread newest-page-first, like every other history read', async () => {
    const aName = 'dm-page-a'
    const bName = 'dm-page-b'
    await registerSession(port, aName)
    const bId = await registerSession(port, bName)
    for (let i = 1; i <= 5; i++) {
      await sendDm(port, bId, aName, `msg ${i}`)
      // Space the sends so no two share a millisecond: the `before` cursor is
      // ts-based, and equal-ts messages are deliberately kept in one page
      // (see pageHistory), which would blur the page boundaries asserted here.
      await new Promise<void>((r) => setTimeout(r, 3))
    }

    const newest = await readDmPage(port, bId, aName, { limit: 2 })
    expect(newest.messages.map((m) => m.text)).toEqual(['msg 4', 'msg 5'])
    expect(newest.hasMore).toBe(true)

    const older = await readDmPage(port, bId, aName, { limit: 2, before: newest.messages[0]!.ts })
    expect(older.messages.map((m) => m.text)).toEqual(['msg 2', 'msg 3'])
    expect(older.hasMore).toBe(true)

    const oldest = await readDmPage(port, bId, aName, { limit: 2, before: older.messages[0]!.ts })
    expect(oldest.messages.map((m) => m.text)).toEqual(['msg 1'])
    expect(oldest.hasMore).toBe(false)

    // The other party pages the same thread identically.
    const aId = (await readDmPage(port, bId, aName)).messages[0]!.fromId
    const asB = await readDmPage(port, aId, bName, { limit: 1 })
    expect(asB.messages.map((m) => m.text)).toEqual(['msg 5'])
    expect(asB.hasMore).toBe(true)
  })

  it('assigns a fresh id after a deregister+re-register, and never leaks a DM for the new id to the old connection', async () => {
    const name = 'dm-reuse-name'
    const idFirst = await registerSession(port, name)
    // The first registration holds an open, tagged SSE connection.
    const stale = openStream(port, name)
    // Give the connection a moment to attach at the broker.
    await new Promise<void>((r) => setTimeout(r, 100))

    // The first registration goes away, then a new session reuses the
    // exact same display name.
    await deleteSession(port, name)
    const idSecond = await registerSession(port, name)
    // AC2: a relaunch under the same name is a new registration, new id.
    expect(idSecond).not.toBe(idFirst)

    // A DM addressed to the NEW id must never surface on the OLD
    // registration's still-open connection (AC6 privacy under name reuse).
    const sender = 'dm-reuse-sender'
    await registerSession(port, sender)
    await sendDm(port, idSecond, sender, 'for the new session only')
    await new Promise<void>((r) => setTimeout(r, 200))
    expect(stale.events.some((e) => e.type === 'dm')).toBe(false)
    stale.close()
  })

  it('never leaks a DM into the untagged /events broadcast lane (AC6)', async () => {
    // An untagged SSE connection is what channel/topic subscribers use; a
    // DM must reach ONLY the recipient's tagged connection. This guards
    // against a future refactor that routes DMs through broadcast().
    const senderName = 'dm-untagged-sender'
    const recipientName = 'dm-untagged-recipient'
    const recipientId = await registerSession(port, recipientName)
    await registerSession(port, senderName)

    const untagged = openStream(port, undefined)
    // Also open the recipient's tagged stream so the DM has somewhere
    // legitimate to land - otherwise `delivered:false` would trivially
    // starve the leak channel.
    const recipientTagged = openStream(port, recipientName)
    await new Promise<void>((r) => setTimeout(r, 100))

    const res = await sendDm(port, recipientId, senderName, 'private for recipient only')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: boolean }
    expect(body.delivered).toBe(true)

    await new Promise<void>((r) => setTimeout(r, 200))
    expect(recipientTagged.events.some((e) => e.type === 'dm')).toBe(true)
    expect(untagged.events.some((e) => e.type === 'dm')).toBe(false)
    untagged.close()
    recipientTagged.close()
  })
})
