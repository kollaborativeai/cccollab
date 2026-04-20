import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
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

describe('Broker: isolation guards and invariants', () => {
  let broker: ChildProcess
  let port: number

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
})
