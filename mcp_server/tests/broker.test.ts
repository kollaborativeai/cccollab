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

/**
 * A path-matching regex constant, as written in `broker.ts`, turned into the
 * paths it accepts in the notation the route table uses:
 * `/^\/topics\/([^/]+)\/(join|leave)$/` -> `/topics/:id/join`, `/topics/:id/leave`.
 *
 * Derived rather than hardcoded so the route sweep cannot go stale against the
 * matcher it claims to describe.
 */
function pathsMatchedBy(regexSource: string): string[] {
  const path = regexSource
    .replace(/^\/\^/, '')
    .replace(/\$\/$/, '')
    .replace(/\\\//g, '/')
    .replace(/\(\[\^\/\]\+\)/g, ':id')
  const alternation = /\(([a-z|]+)\)/.exec(path)
  if (!alternation) return [path]
  return alternation[1]!.split('|').map((option) => path.replace(alternation[0]!, option))
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

async function listTopics(
  port: number,
  query: { sessionId?: string; channel?: string; includeArchived?: boolean } = {},
): Promise<Response> {
  const params = new URLSearchParams()
  if (query.sessionId !== undefined) params.set('sessionId', query.sessionId)
  if (query.channel !== undefined) params.set('channel', query.channel)
  if (query.includeArchived) params.set('include_archived', 'true')
  const qs = params.toString() ? `?${params.toString()}` : ''
  return fetch(`http://127.0.0.1:${port}/topics${qs}`)
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
 *
 * `as` is the session the connection identifies as. Channel-tagged events only
 * reach connections whose session is subscribed to that channel (KAI-446), so
 * a caller watching for one must name a session that is entitled to it.
 */
function nextEvent(
  port: number,
  as: string,
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
      {
        host: '127.0.0.1',
        port,
        path: `/events?sessionId=${encodeURIComponent(as)}`,
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
      // 403, not the 400 this route used to answer from its own copy of the
      // rule: it is refused, not malformed, and it now says so the way every
      // other subscription-gated route does (KAI-446).
      expect(res.status).toBe(403)
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
      // 403 for the same reason as the broadcast guard above.
      expect(res.status).toBe(403)
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
        'attrib-a',
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

    /** The topic's state as its owner sees it — the after-state a refused
     *  archive/unarchive has to leave untouched. */
    async function topicState(topicId: string, sessionId: string): Promise<string> {
      const res = await fetch(`http://127.0.0.1:${port}/topics/${topicId}?sessionId=${encodeURIComponent(sessionId)}`)
      const { topic } = (await res.json()) as { topic: { state: string } }
      return topic.state
    }

    async function leaveTopic(topicId: string, sessionId: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/topics/${topicId}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
    }

    /**
     * Victim owns a topic in `secret` holding one sensitive message; the
     * attacker is registered and subscribed to a DECOY channel, never `secret`.
     *
     * The decoy is load-bearing. With the attacker holding no subscriptions at
     * all, every assertion in this block is equally satisfied by a guard that
     * checks "has any subscription" instead of "has THIS subscription" - and
     * that substitution is the bug family this repo has shipped repeatedly.
     * Subscribing the attacker somewhere else makes the two hypotheses produce
     * different answers, so the tests can tell them apart.
     */
    async function setup(tag: string): Promise<{
      topicId: string
      channel: string
      victim: string
      attacker: string
      decoy: string
    }> {
      const victim = `k446-victim-${tag}`
      const attacker = `k446-attacker-${tag}`
      const channel = `k446-secret-${tag}`
      const decoy = `k446-decoy-${tag}`
      await registerSession(port, victim)
      await joinChannel(port, victim, channel)
      const { id } = (await (await createTopic(port, victim, `k446-topic-${tag}`, channel)).json()) as {
        id: string
      }
      await postTopicMessage(port, id, victim, 'TOP SECRET: launch codes 1234')
      await registerSession(port, attacker)
      await joinChannel(port, attacker, decoy)
      return { topicId: id, channel, victim, attacker, decoy }
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
      const { topicId, victim, attacker } = await setup('arch')
      const res = await archiveTopic(port, topicId, attacker)
      expect(res.status).toBe(403)
      // ...and the archive did not happen. This has to read `state`: read-history
      // serves an archived topic identically, so asserting `messages` is defined
      // stays green even when the guard lets the mutation through.
      expect(await topicState(topicId, victim)).toBe('active')
    })

    it('rejects unarchive from a session not subscribed to the channel', async () => {
      const { topicId, victim, attacker } = await setup('unarch')
      expect((await archiveTopic(port, topicId, victim)).status).toBe(200)
      const res = await unarchiveTopic(port, topicId, attacker)
      expect(res.status).toBe(403)
      // ...and the topic is still archived. Status alone would pass a guard that
      // answers 403 *after* doing the work — the same hole the archive test above
      // was fixed for, and it is only a mutation away on either route.
      expect(await topicState(topicId, victim)).toBe('archived')
    })

    /**
     * Parity with `join`, which 403s an unsubscribed session. NOT a claim that
     * one session cannot evict another: `leave`'s body carries only the session
     * to remove and the loopback broker has no caller identity, so "attacker
     * evicts victim" is indistinguishable from "victim leaves". That is the
     * documented honor-system model and is out of scope here.
     *
     * Status is also all this can assert, unlike its archive/unarchive siblings:
     * `t.joinedSessions` is written by join/leave and read by nothing in the
     * broker, so a guard that evicts before refusing has no observable effect to
     * catch — over HTTP or otherwise.
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

    /**
     * The rest of this block proves "an unsubscribed caller is refused". This
     * one proves the guard discriminates on the RIGHT thing: the caller holds a
     * real subscription, just not to this topic's channel.
     *
     * Without it the whole block is satisfied by a guard that only asks "does
     * this session have any subscription at all" - the has-a-role-instead-of-
     * has-THIS-role family this repo has shipped repeatedly. `setup()`
     * subscribes the attacker to a decoy for the same reason; this test states
     * the requirement out loud so it cannot be optimised away as redundant.
     */
    it('discriminates on the channel, not on merely holding some subscription', async () => {
      const { topicId, victim, attacker, decoy } = await setup('discriminate')

      // Precondition: the attacker really is subscribed to something.
      const attackerChannels = await listChannels(port, attacker)
      expect(attackerChannels.map((c) => c.name)).toEqual([decoy])

      // Same session, same non-empty subscription set, both verdicts.
      expect((await readHistory(topicId, { sessionId: attacker })).status).toBe(403)
      expect((await readHistory(topicId, { sessionId: victim })).status).toBe(200)

      expect((await archiveTopic(port, topicId, attacker)).status).toBe(403)
      expect((await unarchiveTopic(port, topicId, attacker)).status).toBe(403)
      expect((await leaveTopic(topicId, attacker)).status).toBe(403)
    })
  })

  /**
   * KAI-446 (follow-up): the topic ROUTES were gated, but `/events` fanned every
   * event out to every connected SSE client with no identity and no filter, and
   * the only channel filtering lived client-side in `broker-event-listener.ts`.
   * A cooperating client filtered; a hostile one just read the wire. So the
   * ticket's own proof sentence - an unsubscribed local process can read topic
   * message text - stayed true with every route gated.
   *
   * These assert the unsubscribed connection RECEIVES NOTHING, so deleting the
   * server-side filter turns them red. A test that only asserted the subscribed
   * connection still gets its events would stay green with the hole reopened.
   */
  describe('KAI-446: /events is subscription-scoped server-side', () => {
    const SENTINEL = 'TOP SECRET: launch codes 1234'

    /**
     * Opens one SSE connection per entry in `as` (a session name, or `null` for
     * an anonymous connection), fires `trigger` once every connection is live,
     * then returns what each connection actually received.
     *
     * Negative assertions need this rather than `nextEvent`: proving a
     * connection never received something means watching the whole window, not
     * resolving on the first match.
     */
    type SeenEvents = Record<string, unknown>[]

    async function eventsPerConnection<K extends string>(
      as: Record<K, string | null>,
      trigger: () => Promise<void>,
      settleMs = 400,
    ): Promise<Record<K, SeenEvents>> {
      const entries = Object.entries(as) as Array<[K, string | null]>
      const seen = Object.fromEntries(entries.map(([k]) => [k, [] as SeenEvents])) as Record<K, SeenEvents>
      const reqs = await Promise.all(
        entries.map(
          ([key, sessionId]) =>
            new Promise<http.ClientRequest>((resolve, reject) => {
              const path = sessionId === null ? '/events' : `/events?sessionId=${encodeURIComponent(sessionId)}`
              const req = http.get(
                { host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream' } },
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
                        seen[key].push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>)
                      } catch {
                        /* keepalive / non-JSON frame */
                      }
                    }
                  })
                  resolve(req)
                },
              )
              req.on('error', reject)
            }),
        ),
      )
      try {
        await trigger()
        await new Promise<void>((r) => setTimeout(r, settleMs))
      } finally {
        for (const req of reqs) req.destroy()
      }
      return seen
    }

    /** Victim owns a topic in its own channel; the outsider is registered and
     *  subscribed to a DIFFERENT channel, never the victim's. */
    async function stage(tag: string): Promise<{
      topicId: string
      channel: string
      victim: string
      outsider: string
      decoy: string
    }> {
      const victim = `sse-victim-${tag}`
      const outsider = `sse-outsider-${tag}`
      const channel = `sse-secret-${tag}`
      const decoy = `sse-decoy-${tag}`
      await registerSession(port, victim)
      await joinChannel(port, victim, channel)
      const { id } = (await (await createTopic(port, victim, `sse-topic-${tag}`, channel)).json()) as { id: string }
      await registerSession(port, outsider)
      await joinChannel(port, outsider, decoy)
      return { topicId: id, channel, victim, outsider, decoy }
    }

    it('never sends a topic message to a connection subscribed only to another channel', async () => {
      const { topicId, victim, outsider } = await stage('msg')
      const seen = await eventsPerConnection({ outsider, victim }, async () => {
        expect((await postTopicMessage(port, topicId, victim, SENTINEL)).status).toBe(200)
      })
      // The whole point of the ticket: the text must never reach the wire.
      expect(JSON.stringify(seen.outsider)).not.toContain('launch codes')
      expect(seen.outsider).toEqual([])
      // ...and the legitimate subscriber is unaffected.
      expect(JSON.stringify(seen.victim)).toContain(SENTINEL)
    })

    it('never sends a channel broadcast to a connection subscribed only to another channel', async () => {
      const { channel, victim, outsider } = await stage('bcast')
      const seen = await eventsPerConnection({ outsider, victim }, async () => {
        expect((await broadcast(port, victim, channel, SENTINEL)).status).toBe(200)
      })
      expect(seen.outsider).toEqual([])
      expect(JSON.stringify(seen.victim)).toContain(SENTINEL)
    })

    it('never sends topic lifecycle events to a connection subscribed only to another channel', async () => {
      const { topicId, channel, victim, outsider } = await stage('lifecycle')
      const seen = await eventsPerConnection({ outsider, victim }, async () => {
        expect((await createTopic(port, victim, 'sse-second-topic', channel)).status).toBe(200)
        expect((await archiveTopic(port, topicId, victim)).status).toBe(200)
        expect((await unarchiveTopic(port, topicId, victim)).status).toBe(200)
      })
      expect(seen.outsider).toEqual([])
      expect(seen.victim.map((e) => e.type)).toEqual(['topic_created', 'topic_archived', 'topic_unarchived'])
    })

    it('never sends a channel-tagged event to an anonymous connection', async () => {
      const { topicId, victim } = await stage('anon')
      const seen = await eventsPerConnection({ anon: null }, async () => {
        expect((await postTopicMessage(port, topicId, victim, SENTINEL)).status).toBe(200)
      })
      expect(seen.anon).toEqual([])
    })

    it('never sends a channel-tagged event to a connection naming an unregistered session', async () => {
      const { topicId, victim } = await stage('ghost')
      const seen = await eventsPerConnection({ ghost: 'sse-never-registered' }, async () => {
        expect((await postTopicMessage(port, topicId, victim, SENTINEL)).status).toBe(200)
      })
      expect(seen.ghost).toEqual([])
    })

    /**
     * The untagged lane must stay wide. Events with no channel are how the
     * broker signals things that are not channel-scoped, and KAI-514's DM work
     * relies on this lane existing and reaching every connection - its
     * "no leak into the untagged broadcast lane" guard is only meaningful while
     * an untagged event genuinely would reach everyone.
     */
    it('still delivers an untagged event to every connection, including anonymous ones', async () => {
      const { victim, outsider } = await stage('untagged')
      const seen = await eventsPerConnection({ outsider, victim, anon: null }, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/local-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'presence_ping', note: 'untagged' }),
        })
        expect(res.status).toBe(200)
      })
      for (const saw of [seen.outsider, seen.victim, seen.anon]) {
        expect(saw.map((e) => e.type)).toEqual(['presence_ping'])
      }
    })

    /** A channel-tagged event posted through the generic `/local-event` lane is
     *  scoped like any other, so that route is not a way around the filter. */
    it('scopes a channel-tagged /local-event to that channel', async () => {
      const { channel, victim, outsider } = await stage('localevt')
      const seen = await eventsPerConnection({ outsider, victim }, async () => {
        const res = await fetch(`http://127.0.0.1:${port}/local-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'custom', channel, text: SENTINEL }),
        })
        expect(res.status).toBe(200)
      })
      expect(seen.outsider).toEqual([])
      expect(JSON.stringify(seen.victim)).toContain(SENTINEL)
    })

    /** Membership is read at fan-out time, not captured at connect time, so a
     *  join takes effect on a stream that is already open. Without this a
     *  session would have to reconnect after every `join_channel`. */
    it('applies a join that happens after the connection is already open', async () => {
      const { topicId, channel, victim, outsider } = await stage('latejoin')
      const seen = await eventsPerConnection({ outsider }, async () => {
        expect((await postTopicMessage(port, topicId, victim, 'before join')).status).toBe(200)
        expect((await joinChannel(port, outsider, channel)).status).toBe(200)
        expect((await postTopicMessage(port, topicId, victim, 'after join')).status).toBe(200)
      })
      expect(seen.outsider.map((e) => e.text)).toEqual(['after join'])
    })

    /** ...and symmetrically, leaving stops the stream. */
    it('stops delivering once the session leaves the channel', async () => {
      const { topicId, channel, victim, outsider } = await stage('leave')
      await joinChannel(port, outsider, channel)
      const seen = await eventsPerConnection({ outsider }, async () => {
        expect((await postTopicMessage(port, topicId, victim, 'while subscribed')).status).toBe(200)
        expect((await leaveChannel(port, outsider, channel)).status).toBe(200)
        expect((await postTopicMessage(port, topicId, victim, 'after leaving')).status).toBe(200)
      })
      expect(seen.outsider.map((e) => e.text)).toEqual(['while subscribed'])
    })
  })

  /**
   * KAI-446: the ticket's Expected Result is "EVERY route that reads or mutates
   * a topic applies the same subscription check". Per-route tests prove the
   * routes that exist today; they say nothing about the next one somebody adds.
   *
   * This block is the enumeration. `TOPIC_ROUTES` below is the claim, and
   * `discovers every topic route...` is what keeps the claim honest: it reads
   * the broker's own route dispatch and fails if a topic route exists that is
   * not in the table. Adding a route therefore forces you into the sweep, and
   * the sweep runs it against an unsubscribed caller.
   */
  describe('KAI-446: every topic route answers to the subscription rule', () => {
    const SENTINEL = 'TOP SECRET: launch codes 1234'
    const SECRET_CHANNEL = 'k446sweep-secret'
    const SECRET_TOPIC = 'k446sweep-classified'
    const DECOY_CHANNEL = 'k446sweep-decoy'
    const VICTIM = 'k446sweep-victim'
    /** Subscribed to the decoy, never to the secret: "holds a subscription" and
     *  "holds THIS subscription" have to be distinguishable states. */
    const ATTACKER = 'k446sweep-attacker'

    let secretTopicId: string

    beforeAll(async () => {
      await registerSession(port, VICTIM)
      await joinChannel(port, VICTIM, SECRET_CHANNEL)
      const created = await createTopic(port, VICTIM, SECRET_TOPIC, SECRET_CHANNEL)
      secretTopicId = ((await created.json()) as { id: string }).id
      expect((await postTopicMessage(port, secretTopicId, VICTIM, SENTINEL)).status).toBe(200)

      await registerSession(port, ATTACKER)
      await joinChannel(port, ATTACKER, DECOY_CHANNEL)
      expect((await createTopic(port, ATTACKER, 'k446sweep-harmless', DECOY_CHANNEL)).status).toBe(200)
    })

    /**
     * Every route the broker exposes on the topic resource, and what an
     * unsubscribed caller gets from it. `status: 200` is only for the listing
     * route, which answers everyone — scoped to the caller's own channels, so
     * the disclosure assertion is what carries the guarantee there.
     */
    const TOPIC_ROUTES: Array<{ route: string; status: number; probe: (topicId: string) => Promise<Response> }> = [
      {
        route: 'POST /topics',
        status: 403,
        probe: () => createTopic(port, ATTACKER, 'k446sweep-intruder', SECRET_CHANNEL),
      },
      { route: 'GET /topics', status: 200, probe: () => listTopics(port, { sessionId: ATTACKER }) },
      {
        route: 'GET /topics/:id',
        status: 403,
        probe: (id) => fetch(`http://127.0.0.1:${port}/topics/${id}?sessionId=${encodeURIComponent(ATTACKER)}`),
      },
      {
        route: 'GET /topics/:id/messages',
        status: 403,
        probe: (id) =>
          fetch(`http://127.0.0.1:${port}/topics/${id}/messages?sessionId=${encodeURIComponent(ATTACKER)}`),
      },
      {
        route: 'POST /topics/:id/messages',
        status: 403,
        probe: (id) => postTopicMessage(port, id, ATTACKER, 'intrusion'),
      },
      { route: 'POST /topics/:id/join', status: 403, probe: (id) => joinTopic(port, id, ATTACKER) },
      {
        route: 'POST /topics/:id/leave',
        status: 403,
        probe: (id) =>
          fetch(`http://127.0.0.1:${port}/topics/${id}/leave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: ATTACKER }),
          }),
      },
      { route: 'POST /topics/:id/archive', status: 403, probe: (id) => archiveTopic(port, id, ATTACKER) },
      { route: 'POST /topics/:id/unarchive', status: 403, probe: (id) => unarchiveTopic(port, id, ATTACKER) },
    ]

    it.each(TOPIC_ROUTES.map((r) => [r.route, r] as const))(
      '%s refuses an unsubscribed caller and discloses nothing about the topic',
      async (_name, { status, probe }) => {
        const res = await probe(secretTopicId)
        expect(res.status).toBe(status)
        const body = await res.text()
        // Neither the message text nor the topic's own name. The channel name
        // is deliberately NOT asserted absent: a 403 names the channel you
        // would have to join, which is the point of the message.
        expect(body).not.toContain(SENTINEL)
        expect(body).not.toContain(SECRET_TOPIC)
      },
    )

    /**
     * The trap. `TOPIC_ROUTES` is a hand-written claim about what the broker
     * exposes; this reads the dispatch in `broker.ts` and fails when the two
     * disagree. Any new dispatch branch under `/topics` reds this until it is
     * added to the table above — at which point the sweep points an
     * unsubscribed caller at it.
     *
     * Source-reading is deliberate: nothing in the broker's dispatch is
     * introspectable at runtime, and a claim of full coverage that is not
     * mechanically checked is exactly the kind of claim this ticket exists to
     * disprove. Which is why nothing below is hardcoded: an earlier version
     * collected matchers by NAME (`TOPIC_*`) and listed their routes as string
     * literals, so a matcher called something else, and a second verb on a
     * matcher already in the list, both walked straight past it.
     *
     * What it guarantees, stated as narrowly as it is true. Two collectors read
     * the routes out of dispatch (literal compares; matcher constants, by what
     * they match and per verb). Those only see two shapes — so the three
     * assertions after them do not look for routes at all, they pin dispatch to
     * exactly those shapes:
     *
     *   1. nothing that names `/topics` is written any other way,
     *   2. no verb compare sits away from the path test it guards,
     *   3. no dispatch condition is missing a literal verb.
     *
     * Between them, a new ROUTE under `/topics` either lands in one of the two
     * collectors — and then has to be in `TOPIC_ROUTES` — or reds one of the
     * three. Not "in the four shapes I thought of": in any shape, because the
     * shapes are what is asserted. The cost is that dispatch has to keep being
     * written the way it is written today, which is a fair price for a coverage
     * claim that is checked rather than asserted.
     *
     * Two ceilings, stated rather than implied, because a written guarantee is
     * what the next reader trusts instead of re-deriving:
     *
     * - It scans dispatch under `/topics`. A topic read served from some other
     *   prefix (`GET /export/:id`, say) is not found — no source scan can decide
     *   which paths disclose topic content, so that call stays human.
     * - It discovers routes, not disclosures WITHIN a route. An early
     *   `if (searchParams.has('raw'))` returning `t.messages` ahead of the guard
     *   in an already-swept handler adds no route, so nothing here reds and the
     *   sweep does not see it either — its probe sends one canonical request per
     *   route, not every parameter that route accepts. Verified, not assumed:
     *   that mutation is green against this whole suite. Guard bypasses inside a
     *   handler are what `requireSubscribed` being a single chokepoint is for,
     *   and what reviewing the handler body is for.
     */
    it('discovers every topic route in broker.ts, so a new one cannot skip the sweep', () => {
      const source = readFileSync(fileURLToPath(new URL('../src/broker.ts', import.meta.url)), 'utf-8')

      // Whole-path compares: `pathname === '/topics…' && method === 'X'`.
      const literal = [...source.matchAll(/pathname === '(\/topics[^']*)' && method === '(\w+)'/g)].map(
        (m) => `${m[2]} ${m[1]}`,
      )

      // Path-matching regex constants, collected by what they MATCH rather than
      // what they are named, and turned into the paths they accept.
      const matchers = new Map<string, string[]>()
      for (const [, name, body] of source.matchAll(/^const (\w+) = (\/\^[^\n]+\/)$/gm)) {
        if (body!.includes('/topics')) matchers.set(name!, pathsMatchedBy(body!))
      }

      // The verbs each matcher dispatches, one entry per branch, so a second
      // verb on a matcher that already has one is a new route here too.
      const bindings = new Map<string, string>()
      for (const [, variable, name] of source.matchAll(/const (\w+) = (\w+)\.exec\(pathname\)/g)) {
        bindings.set(variable!, name!)
      }
      const matched: string[] = []
      for (const [variable, name] of bindings) {
        const paths = matchers.get(name)
        if (!paths) continue
        const usage = new RegExp(`\\b${variable}\\b`)
        for (const line of source.split('\n').filter((l) => usage.test(l))) {
          for (const [, verb] of line.matchAll(/method === '(\w+)'/g)) {
            matched.push(...paths.map((p) => `${verb} ${p}`))
          }
        }
      }

      // Every `/topics` matcher reaches dispatch through one of those bindings.
      // An inline `TOPIC_X_ROUTE.test(pathname)` would carry no binding, and its
      // verbs would go uncollected above.
      const bound = [...new Set(bindings.values())].filter((name) => matchers.has(name))
      expect([...matchers.keys()].sort()).toEqual(bound.sort())

      // ...and nothing else in the dispatch names `/topics` at all, so a branch
      // written in some third shape (an inline regex literal, a `startsWith`)
      // cannot serve a topic path without first showing up here.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const line of code.split('\n').filter((l) => l.includes('/topics'))) {
        expect(line).toMatch(/^(const \w+ = \/|\s*if \(pathname === ')/)
      }

      // ...and every verb compare shares a line with the path test it guards,
      // which is what makes the per-line scan above complete: a condition
      // wrapped across lines would otherwise carry its verb where nothing looks.
      const guarded = new RegExp(`pathname === '|\\b(${[...bindings.keys()].join('|')})\\b`)
      for (const line of code.split('\n').filter((l) => l.includes("method === '"))) {
        expect(line).toMatch(guarded)
      }

      // ...and the converse, which is the half that turns "I checked these
      // shapes" into "there is no other shape": every dispatch condition carries
      // a LITERAL verb. A branch with no `method` compare (`if (pathname ===
      // '/topics/export')`, answering every verb) or one comparing against a
      // variable both name a real route that the two collectors above produce
      // nothing for — and the route table would agree with them, vacuously.
      const dispatches = new RegExp(`\\bpathname\\b|\\b(${[...bindings.keys()].join('|')})\\b`)
      for (const line of code.split('\n').filter((l) => /^\s*if \(/.test(l) && dispatches.test(l))) {
        expect(line).toMatch(/method === '\w+'/)
      }

      expect([...literal, ...matched].sort()).toEqual(TOPIC_ROUTES.map((r) => r.route).sort())
    })

    it('refuses to list topics for a caller that names no session at all', async () => {
      const res = await listTopics(port)
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain(SECRET_TOPIC)
    })

    it('refuses to list a channel the caller is not subscribed to', async () => {
      const res = await listTopics(port, { sessionId: ATTACKER, channel: SECRET_CHANNEL })
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain(SECRET_TOPIC)
    })

    it('lists the caller its own channels and no others', async () => {
      const res = await listTopics(port, { sessionId: ATTACKER })
      expect(res.status).toBe(200)
      const { topics } = (await res.json()) as { topics: Array<{ topic: string; channel: string }> }
      expect(topics.map((t) => t.channel)).toEqual([DECOY_CHANNEL])
      expect(topics.map((t) => t.topic)).toEqual(['k446sweep-harmless'])
    })
  })
})
