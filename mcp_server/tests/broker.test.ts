import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTsx } from '../src/resolve-tsx.js'

const PROFILE = `btest-${process.pid}`
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

async function registerSession(port: number, name: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  expect(res.status).toBe(200)
}

async function joinChannel(port: number, sessionId: string, channel: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/channels/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, channel }),
  })
}

async function leaveChannel(port: number, sessionId: string, channel: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/channels/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, channel }),
  })
}

async function listChannels(
  port: number,
  sessionId: string,
): Promise<Array<{ name: string; subscriberCount: number }>> {
  const res = await fetch(`http://127.0.0.1:${port}/channels?sessionId=${encodeURIComponent(sessionId)}`)
  const body = (await res.json()) as { channels: Array<{ name: string; subscriberCount: number }> }
  return body.channels
}

async function createTopic(port: number, creator: string, topic: string, channel: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/topics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, creator, channel }),
  })
}

async function broadcast(port: number, sender: string, channel: string, text: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, channel, text }),
  })
}

async function postTopicMessage(port: number, topicId: string, sender: string, text: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/topics/${topicId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, text }),
  })
}

async function joinTopic(port: number, topicId: string, sessionId: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/topics/${topicId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
}

async function archiveTopic(port: number, topicId: string, archivedBy: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/topics/${topicId}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivedBy }),
  })
}

async function unarchiveTopic(port: number, topicId: string, unarchivedBy: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/topics/${topicId}/unarchive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unarchivedBy }),
  })
}

/**
 * Opens the broker's SSE `/events` stream (via raw node:http, which streams
 * small SSE frames reliably), fires `trigger` once the connection is live, and
 * resolves the first broadcast event matching `predicate`.
 */
function nextEvent(
  port: number,
  predicate: (evt: Record<string, unknown>) => boolean,
  trigger: () => Promise<void>,
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
      { host: '127.0.0.1', port, path: '/events', headers: { Accept: 'text/event-stream' } },
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
        // Connection is live — safe to fire the action that produces the event.
        trigger().catch(reject)
      },
    )
    req.on('error', reject)
  })
}

describe('Broker: isolation guards and invariants', () => {
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

  describe('send_message_to_channel guard (broadcast)', () => {
    it('refuses broadcast from a sender not subscribed to the target channel', async () => {
      await registerSession(port, 'guard-bcast-1')
      await joinChannel(port, 'guard-bcast-1', 'guard-bcast-ch')
      await registerSession(port, 'guard-bcast-2')
      const res = await broadcast(port, 'guard-bcast-2', 'guard-bcast-ch', 'should fail')
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/not subscribed/i)
    })

    it('accepts broadcast from a subscribed sender', async () => {
      await registerSession(port, 'guard-bcast-ok')
      await joinChannel(port, 'guard-bcast-ok', 'guard-bcast-ok-ch')
      const res = await broadcast(port, 'guard-bcast-ok', 'guard-bcast-ok-ch', 'ok')
      expect(res.status).toBe(200)
    })
  })

  describe('start_topic guard', () => {
    it('refuses topic creation when creator is not subscribed to the channel', async () => {
      await registerSession(port, 'guard-st-1')
      // No joinChannel for guard-st-1
      const res = await createTopic(port, 'guard-st-1', 'denied-topic', 'guard-st-ch')
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/not subscribed/i)
    })
  })

  describe('join_topic guard', () => {
    it("refuses topic join when session is not subscribed to the topic's channel", async () => {
      await registerSession(port, 'guard-jt-creator')
      await joinChannel(port, 'guard-jt-creator', 'guard-jt-ch')
      const createRes = await createTopic(port, 'guard-jt-creator', 'gated', 'guard-jt-ch')
      expect(createRes.status).toBe(200)
      const { id } = (await createRes.json()) as { id: string }

      await registerSession(port, 'guard-jt-outsider')
      const res = await joinTopic(port, id, 'guard-jt-outsider')
      expect(res.status).toBe(403)
    })
  })

  describe('send_message_to_topic guard', () => {
    it("refuses message posting when sender is not subscribed to the topic's channel", async () => {
      await registerSession(port, 'guard-mt-creator')
      await joinChannel(port, 'guard-mt-creator', 'guard-mt-ch')
      const createRes = await createTopic(port, 'guard-mt-creator', 'mt-topic', 'guard-mt-ch')
      const { id } = (await createRes.json()) as { id: string }

      await registerSession(port, 'guard-mt-outsider')
      const res = await postTopicMessage(port, id, 'guard-mt-outsider', 'should fail')
      expect(res.status).toBe(403)
    })
  })

  describe('topic name uniqueness', () => {
    it('rejects duplicate topic names within the same channel with 409', async () => {
      await registerSession(port, 'uniq-1')
      await joinChannel(port, 'uniq-1', 'uniq-ch')
      const first = await createTopic(port, 'uniq-1', 'duplicate-name', 'uniq-ch')
      expect(first.status).toBe(200)
      const second = await createTopic(port, 'uniq-1', 'duplicate-name', 'uniq-ch')
      expect(second.status).toBe(409)
      const body = (await second.json()) as { error: string }
      expect(body.error).toMatch(/already exists/i)
    })

    it('allows the same topic name in different channels', async () => {
      await registerSession(port, 'uniq-2')
      await joinChannel(port, 'uniq-2', 'uniq-ch-a')
      await joinChannel(port, 'uniq-2', 'uniq-ch-b')
      const a = await createTopic(port, 'uniq-2', 'shared-name', 'uniq-ch-a')
      expect(a.status).toBe(200)
      const b = await createTopic(port, 'uniq-2', 'shared-name', 'uniq-ch-b')
      expect(b.status).toBe(200)
      const aBody = (await a.json()) as { id: string }
      const bBody = (await b.json()) as { id: string }
      expect(aBody.id).not.toBe(bBody.id)
    })
  })

  describe('channel garbage collection', () => {
    it('removes the channel from listings when the last subscriber leaves', async () => {
      await registerSession(port, 'gc-1')
      await registerSession(port, 'gc-2')
      await joinChannel(port, 'gc-1', 'gc-ch')
      await joinChannel(port, 'gc-2', 'gc-ch')

      // Both subscribed from gc-1's perspective
      const beforeAny = await listChannels(port, 'gc-1')
      expect(beforeAny.some((c) => c.name === 'gc-ch')).toBe(true)

      await leaveChannel(port, 'gc-1', 'gc-ch')
      await leaveChannel(port, 'gc-2', 'gc-ch')

      // After last subscriber leaves, channel no longer exists in the broker.
      // Register a third session that also doesn't join gc-ch - its /channels view
      // should not surface gc-ch at all.
      await registerSession(port, 'gc-3')
      const afterAll = await listChannels(port, 'gc-3')
      expect(afterAll.find((c) => c.name === 'gc-ch')).toBeUndefined()
    })

    it('re-creates the channel implicitly when a new session joins the same name later', async () => {
      await registerSession(port, 'gc-re-1')
      await joinChannel(port, 'gc-re-1', 'gc-re-ch')
      await leaveChannel(port, 'gc-re-1', 'gc-re-ch')

      await registerSession(port, 'gc-re-2')
      const joinRes = await joinChannel(port, 'gc-re-2', 'gc-re-ch')
      expect(joinRes.status).toBe(200)
      const list = await listChannels(port, 'gc-re-2')
      expect(list.find((c) => c.name === 'gc-re-ch')?.subscriberCount).toBe(1)
    })
  })

  describe('paged topic history (GET /topics/:id/messages)', () => {
    /** `sessionId` identifies the reading session — read-history is
     *  subscription-gated (KAI-446), so these paging tests read as the
     *  subscribed session that seeded the topic. */
    async function readHistory(
      topicId: string,
      query: { sessionId?: string; limit?: number; before?: number } = {},
    ): Promise<{
      status: number
      body: { messages: Array<{ sender: string; text: string; ts: number }>; hasMore: boolean }
    }> {
      const params = new URLSearchParams()
      if (query.sessionId !== undefined) params.set('sessionId', query.sessionId)
      if (query.limit !== undefined) params.set('limit', String(query.limit))
      if (query.before !== undefined) params.set('before', String(query.before))
      const qs = params.toString() ? `?${params.toString()}` : ''
      const res = await fetch(`http://127.0.0.1:${port}/topics/${topicId}/messages${qs}`)
      return { status: res.status, body: (await res.json()) as never }
    }

    async function seed(
      session: string,
      channel: string,
      topic: string,
      texts: string[],
      spacingMs = 0,
    ): Promise<string> {
      await registerSession(port, session)
      await joinChannel(port, session, channel)
      const { id } = (await (await createTopic(port, session, topic, channel)).json()) as { id: string }
      for (const text of texts) {
        await postTopicMessage(port, id, session, text)
        if (spacingMs > 0) await new Promise<void>((r) => setTimeout(r, spacingMs))
      }
      return id
    }

    it('returns all messages oldest-first with epoch-ms numeric timestamps', async () => {
      const id = await seed('hist-a', 'hist-ch', 'hist-topic-a', ['one', 'two', 'three'])
      const { status, body } = await readHistory(id, { sessionId: 'hist-a' })
      expect(status).toBe(200)
      expect(body.messages.map((m) => m.text)).toEqual(['one', 'two', 'three'])
      expect(body.messages.every((m) => typeof m.ts === 'number' && Number.isFinite(m.ts))).toBe(true)
      // Non-decreasing timestamps (oldest-first).
      for (let i = 1; i < body.messages.length; i++) {
        expect(body.messages[i]!.ts).toBeGreaterThanOrEqual(body.messages[i - 1]!.ts)
      }
      expect(body.hasMore).toBe(false)
    })

    it('returns an empty page (not an error) for a topic with no messages', async () => {
      const id = await seed('hist-empty', 'hist-empty-ch', 'hist-empty-topic', [])
      const { status, body } = await readHistory(id, { sessionId: 'hist-empty' })
      expect(status).toBe(200)
      expect(body.messages).toEqual([])
      expect(body.hasMore).toBe(false)
    })

    it('caps the page to `limit`, returns the newest page, and sets hasMore', async () => {
      const id = await seed('hist-b', 'hist-b-ch', 'hist-topic-b', ['m1', 'm2', 'm3', 'm4', 'm5'], 2)
      const { body } = await readHistory(id, { sessionId: 'hist-b', limit: 2 })
      // Newest two, still oldest-first within the page.
      expect(body.messages.map((m) => m.text)).toEqual(['m4', 'm5'])
      expect(body.hasMore).toBe(true)
    })

    it('pages backwards with the `before` cursor until hasMore is false', async () => {
      const id = await seed('hist-c', 'hist-c-ch', 'hist-topic-c', ['a', 'b', 'c', 'd'], 2)
      const first = await readHistory(id, { sessionId: 'hist-c', limit: 2 })
      expect(first.body.messages.map((m) => m.text)).toEqual(['c', 'd'])
      expect(first.body.hasMore).toBe(true)

      const cursor = first.body.messages[0]!.ts
      const second = await readHistory(id, { sessionId: 'hist-c', limit: 2, before: cursor })
      expect(second.body.messages.map((m) => m.text)).toEqual(['a', 'b'])
      expect(second.body.hasMore).toBe(false)
    })

    it('returns 404 for an unknown topic id', async () => {
      const { status, body } = await readHistory('00000000-0000-0000-0000-000000000000')
      expect(status).toBe(404)
      expect((body as unknown as { error: string }).error).toMatch(/not found/i)
    })
  })

  describe('leave_channel cascade (regression)', () => {
    it('drops the session from every topic in the channel it left', async () => {
      await registerSession(port, 'casc-a')
      await joinChannel(port, 'casc-a', 'casc-ch')
      const t = await createTopic(port, 'casc-a', 'casc-topic', 'casc-ch')
      const { id } = (await t.json()) as { id: string }

      await registerSession(port, 'casc-b')
      await joinChannel(port, 'casc-b', 'casc-ch')
      const joinOk = await joinTopic(port, id, 'casc-b')
      expect(joinOk.status).toBe(200)

      await leaveChannel(port, 'casc-b', 'casc-ch')

      // Broker should no longer let casc-b interact with the topic
      const rejoin = await joinTopic(port, id, 'casc-b')
      expect(rejoin.status).toBe(403)
      const send = await postTopicMessage(port, id, 'casc-b', 'no')
      expect(send.status).toBe(403)
    })
  })

  describe('topic lifecycle attribution (KAI-373)', () => {
    it('attributes the unarchive event to the acting session', async () => {
      await registerSession(port, 'attrib-a')
      await joinChannel(port, 'attrib-a', 'attrib-ch')
      const created = await createTopic(port, 'attrib-a', 'attrib-topic', 'attrib-ch')
      const { id } = (await created.json()) as { id: string }
      await archiveTopic(port, id, 'attrib-a')

      const evt = await nextEvent(
        port,
        (e) => e.type === 'topic_unarchived' && e.topicId === id,
        async () => {
          const res = await unarchiveTopic(port, id, 'attrib-a')
          expect(res.status).toBe(200)
        },
      )

      expect(evt).not.toBeNull()
      // Mirrors topic_archived's archivedBy so the event isn't attributed to "system".
      expect(evt!.unarchivedBy).toBe('attrib-a')
    })
  })

  /**
   * KAI-446: every topic route that reads or mutates a topic must apply the
   * same channel-subscription check. `GET /topics/:id`, `POST .../messages`
   * and `POST .../join` enforced it; read-history, archive, unarchive and
   * leave did not. These assert the UNSUBSCRIBED identity is REJECTED, so
   * deleting the guard turns them red (a test that only asserted the
   * subscribed session succeeds would stay green with the hole reopened).
   */
  describe('KAI-446: topic route authorization parity', () => {
    async function readHistory(
      topicId: string,
      query: { sessionId?: string; limit?: number; before?: number } = {},
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const params = new URLSearchParams()
      if (query.sessionId !== undefined) params.set('sessionId', query.sessionId)
      if (query.limit !== undefined) params.set('limit', String(query.limit))
      if (query.before !== undefined) params.set('before', String(query.before))
      const qs = params.toString() ? `?${params.toString()}` : ''
      const res = await fetch(`http://127.0.0.1:${port}/topics/${topicId}/messages${qs}`)
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }

    async function leaveTopic(topicId: string, sessionId: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/topics/${topicId}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
    }

    /** Victim owns a topic in `secret` holding one sensitive message; the
     *  attacker is registered but has never joined `secret`. */
    async function setup(tag: string): Promise<{ topicId: string; victim: string; attacker: string }> {
      const victim = `k446-victim-${tag}`
      const attacker = `k446-attacker-${tag}`
      const channel = `k446-secret-${tag}`
      await registerSession(port, victim)
      await joinChannel(port, victim, channel)
      const { id } = (await (await createTopic(port, victim, `k446-topic-${tag}`, channel)).json()) as {
        id: string
      }
      await postTopicMessage(port, id, victim, 'TOP SECRET: launch codes 1234')
      await registerSession(port, attacker)
      return { topicId: id, victim, attacker }
    }

    it('rejects read-history from a session not subscribed to the channel', async () => {
      const { topicId, attacker } = await setup('read')
      const { status, body } = await readHistory(topicId, { sessionId: attacker })
      expect(status).toBe(403)
      expect(JSON.stringify(body)).not.toContain('launch codes')
    })

    it('rejects read-history that supplies no sessionId at all', async () => {
      const { topicId } = await setup('nosid')
      const { status, body } = await readHistory(topicId)
      expect(status).toBe(400)
      expect(JSON.stringify(body)).not.toContain('launch codes')
    })

    it('still serves read-history to a subscribed session (guard does not over-block)', async () => {
      const { topicId, victim } = await setup('ok')
      const { status, body } = await readHistory(topicId, { sessionId: victim })
      expect(status).toBe(200)
      expect(JSON.stringify(body)).toContain('launch codes')
    })

    it('rejects archive from a session not subscribed to the channel', async () => {
      const { topicId, attacker } = await setup('arch')
      const res = await archiveTopic(port, topicId, attacker)
      expect(res.status).toBe(403)
      // and the topic is still active for its owner
      const { body } = await readHistory(topicId, { sessionId: `k446-victim-arch` })
      expect(body.messages).toBeDefined()
    })

    it('rejects unarchive from a session not subscribed to the channel', async () => {
      const { topicId, victim, attacker } = await setup('unarch')
      expect((await archiveTopic(port, topicId, victim)).status).toBe(200)
      const res = await unarchiveTopic(port, topicId, attacker)
      expect(res.status).toBe(403)
    })

    /**
     * Parity with `join`, which 403s an unsubscribed session. NOT a claim that
     * one session cannot evict another: `leave`'s body carries only the session
     * to remove and the loopback broker has no caller identity, so "attacker
     * evicts victim" is indistinguishable from "victim leaves". That is the
     * documented honor-system model and is out of scope here.
     */
    it('rejects leave from a session not subscribed to the channel', async () => {
      const { topicId, attacker } = await setup('leave')
      const res = await leaveTopic(topicId, attacker)
      expect(res.status).toBe(403)
    })

    it('still allows a subscribed session to archive and unarchive', async () => {
      const { topicId, victim } = await setup('happy')
      expect((await archiveTopic(port, topicId, victim)).status).toBe(200)
      expect((await unarchiveTopic(port, topicId, victim)).status).toBe(200)
    })
  })
})
