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

/** Display name -> most recent registration id, so the helpers below can keep
 *  their readable name-based signatures while the wire talks ids. */
const idByName = new Map<string, string>()

function idOf(name: string): string {
  const id = idByName.get(name)
  if (!id) throw new Error(`register "${name}" before using it`)
  return id
}

/** `id` re-registers an existing registration in place (what `introduce`
 *  does mid-session); omitting it is a brand-new registration. */
async function registerSession(port: number, name: string, id?: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...(id ? { id } : {}) }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; id: string }
  idByName.set(name, body.id)
  return body.id
}

async function listSessions(port: number): Promise<Array<{ id: string; name: string; lastSeen?: string }>> {
  const res = await fetch(`http://127.0.0.1:${port}/sessions`)
  return ((await res.json()) as { sessions: Array<{ id: string; name: string; lastSeen?: string }> }).sessions
}

async function sendDm(port: number, toId: string, from: string, text: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(toId)}/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromId: idOf(from), text }),
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
  const params = new URLSearchParams({ asId: idOf(asName) })
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
  await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(idOf(name))}`, { method: 'DELETE' })
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

  it('re-introducing with the registration id keeps that id (rename in place)', async () => {
    const first = await registerSession(port, 'dm-reg-stable')
    const second = await registerSession(port, 'dm-reg-stable', first)
    expect(second).toBe(first)
    // The same registration can change its display name without becoming a
    // second one - `introduce` is callable again mid-session.
    const renamed = await registerSession(port, 'dm-reg-renamed', first)
    expect(renamed).toBe(first)
    const sessions = await listSessions(port)
    expect(sessions.filter((s) => s.id === first).map((s) => s.name)).toEqual(['dm-reg-renamed'])
  })

  /**
   * AC2: an id identifies one REGISTRATION, not a role. A relaunch after a
   * crash sends no id (the process that held it is gone), and there is no
   * DELETE on the SIGKILL path - so the broker must not hand the dead
   * registration's id to the new process, or a stale id an orchestrator is
   * holding silently retargets a different process.
   */
  it('mints a new id for a bare re-register under the same name (crash relaunch)', async () => {
    const first = await registerSession(port, 'dm-reg-crash')
    const second = await registerSession(port, 'dm-reg-crash')
    expect(second).not.toBe(first)
  })

  /**
   * AC2: two live sessions that pick the same display name are two
   * registrations. The fleet convention names sessions by role ("reviewer",
   * "worker"), so this collision is routine, not exotic.
   */
  it('gives two concurrent sessions sharing a display name distinct ids, and DMs only the addressed one', async () => {
    const twinA = await registerSession(port, 'dm-twin')
    const twinB = await registerSession(port, 'dm-twin')
    expect(twinA).not.toBe(twinB)

    const sender = 'dm-twin-sender'
    await registerSession(port, sender)
    const streamA = openStream(port, twinA)
    const streamB = openStream(port, twinB)
    await new Promise<void>((r) => setTimeout(r, 100))

    const res = await sendDm(port, twinA, sender, 'for twin A only')
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(true)
    await new Promise<void>((r) => setTimeout(r, 200))

    expect(streamA.events.some((e) => e.type === 'dm')).toBe(true)
    expect(streamB.events.some((e) => e.type === 'dm')).toBe(false)
    streamA.close()
    streamB.close()
  })

  /**
   * AC1: the recipient is resolved by id and ONLY by id. Addressing a
   * registered peer's display name - a string that resolves fine under any
   * name fallback - must still miss.
   */
  it('refuses a DM addressed to a registered peer display name, with no name fallback', async () => {
    await registerSession(port, 'dm-byname-recipient')
    await registerSession(port, 'dm-byname-sender')
    const stream = openStream(port, 'dm-byname-recipient')
    await new Promise<void>((r) => setTimeout(r, 100))

    const res = await sendDm(port, 'dm-byname-recipient', 'dm-byname-sender', 'by name?')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: boolean; reason?: string }
    expect(body.delivered).toBe(false)
    expect(body.reason).toMatch(/unknown recipient id/i)
    await new Promise<void>((r) => setTimeout(r, 200))
    expect(stream.events.some((e) => e.type === 'dm')).toBe(false)
    stream.close()
  })

  /**
   * The delivery lane is keyed by registration id, so a connection can only
   * receive a session's DMs by knowing that session's id. Tagging a stream
   * with a display name - which any process can guess - reaches nothing.
   */
  it('never delivers to a stream tagged with the recipient display name instead of its id', async () => {
    const victimId = await registerSession(port, 'dm-impostor-victim')
    await registerSession(port, 'dm-impostor-sender')
    const impostor = openStream(port, 'dm-impostor-victim')
    await new Promise<void>((r) => setTimeout(r, 100))

    const res = await sendDm(port, victimId, 'dm-impostor-sender', 'victim eyes only')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { delivered: boolean; reason?: string }
    // The victim itself never attached, so honest delivery is false...
    expect(body.delivered).toBe(false)
    expect(body.reason).toMatch(/attached/i)
    await new Promise<void>((r) => setTimeout(r, 200))
    // ...and the message reached nobody.
    expect(impostor.events.some((e) => e.type === 'dm')).toBe(false)
    impostor.close()
  })

  /**
   * Per-registration ids mean a crashed session's row outlives it (there is
   * no DELETE on the SIGKILL path). `lastSeen` is what lets `list_sessions`
   * age that row out instead of showing two identically-named sessions
   * forever - it tracks the live SSE connection and freezes when it drops.
   */
  it('reports lastSeen from the live connection, frozen once the session detaches', async () => {
    const id = await registerSession(port, 'dm-liveness')
    const lastSeenOf = async (): Promise<string> => {
      const row = (await listSessions(port)).find((s) => s.id === id)
      expect(row?.lastSeen).toBeTruthy()
      return row!.lastSeen!
    }

    const stream = openStream(port, id)
    await new Promise<void>((r) => setTimeout(r, 100))
    const attachedFirst = await lastSeenOf()
    await new Promise<void>((r) => setTimeout(r, 30))
    const attachedSecond = await lastSeenOf()
    // Attached: liveness keeps advancing, so the row never looks stale.
    expect(attachedSecond > attachedFirst).toBe(true)

    stream.close()
    await new Promise<void>((r) => setTimeout(r, 150))
    const detachedFirst = await lastSeenOf()
    await new Promise<void>((r) => setTimeout(r, 30))
    // Detached: frozen at the disconnect, so the staleness filter can drop it.
    expect(await lastSeenOf()).toBe(detachedFirst)
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
      recipientId,
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
    const stale = openStream(port, idFirst)
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
    const recipientTagged = openStream(port, recipientId)
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
