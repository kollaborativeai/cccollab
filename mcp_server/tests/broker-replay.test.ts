import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTsx } from '../src/resolve-tsx.js'

/**
 * The reconnect hole (KAI-414). The SSE stream had no cursor: a client that
 * dropped and reconnected silently lost everything published in the gap, and
 * then reported itself healthy. `watch` promises "you will see every topic",
 * so a silent hole is the confidently-blind failure this ticket exists to kill,
 * one layer down.
 *
 * The broker now stamps every event with `id: <brokerId>:<seq>` and keeps a
 * bounded replay buffer. A reconnecting client sends `Last-Event-ID` and gets
 * everything it missed. When the broker CANNOT honour the cursor — buffer
 * overflowed, or a restarted broker with a new id — it must say so with an
 * explicit `stream_gap` event rather than pretend the replay was complete.
 */
const PROFILE = `replaytest-${process.pid}`
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

interface SseEvent {
  id?: string
  data: Record<string, unknown>
}

/** Open an SSE connection, collecting `id:`/`data:` pairs as they arrive. */
function openStream(
  port: number,
  lastEventId?: string,
): { events: SseEvent[]; close: () => void; ready: Promise<void> } {
  const events: SseEvent[] = []
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((r) => {
    resolveReady = r
  })
  const req = http.get(
    `http://127.0.0.1:${port}/events`,
    { headers: lastEventId ? { 'Last-Event-ID': lastEventId } : {} },
    (res) => {
      resolveReady()
      let buffer = ''
      let pendingId: string | undefined
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('id: ')) pendingId = line.slice(4)
          if (line.startsWith('data: ')) {
            events.push({ id: pendingId, data: JSON.parse(line.slice(6)) as Record<string, unknown> })
            pendingId = undefined
          }
        }
      })
    },
  )
  return { events, close: () => req.destroy(), ready }
}

async function post(port: number, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function seedTopic(port: number, sender: string, channel: string, topic: string): Promise<string> {
  await post(port, '/sessions', { name: sender })
  await post(port, '/channels/join', { sessionId: sender, channel })
  const res = await post(port, '/topics', { creator: sender, topic, channel })
  const body = (await res.json()) as { id: string }
  return body.id
}

describe('Broker: replay capacity validation (KAI-414)', () => {
  // NaN capacity used to slip through: `Number('abc')` is NaN, `length > NaN` is
  // always false, eviction never fires, the buffer grows unbounded. Rejecting
  // at boot fails LOUD instead of degrading silently — the direction this
  // feature must never fail.
  it('refuses to boot with a non-numeric CCCOLLAB_REPLAY_CAPACITY', async () => {
    const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
    const brokerPath = fileURLToPath(new URL('../src/broker.ts', import.meta.url))
    const nanProfile = `nan-cap-${process.pid}`
    const nanRendezvous = join(homedir(), '.cccollab', 'run', `${nanProfile}.json`)
    const child = spawn(process.execPath, [tsxCli, brokerPath], {
      env: { ...process.env, CCCOLLAB_PROFILE: nanProfile, CCCOLLAB_REPLAY_CAPACITY: 'abc' },
      stdio: 'ignore',
    })
    const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 0)))
    expect(code).not.toBe(0)
    try {
      unlinkSync(nanRendezvous)
    } catch {
      /* ignore */
    }
  }, 15_000)
})

describe('Broker: replay buffer capacity=0 (KAI-414 F1)', () => {
  // The reviewer's smoking gun: with CCCOLLAB_REPLAY_CAPACITY=0 the buffer is
  // always empty, so the old `oldest && ...` short-circuit never declared a
  // gap — a client behind lastSeq got a silent zero-length replay. That is
  // precisely the "confidently-blind" failure this ticket exists to kill; it
  // is misconfig-gated but fails toward silence, the one direction it must
  // never fail.
  const ZERO_PROFILE = `zerobuf-${process.pid}`
  const ZERO_RENDEZVOUS = join(homedir(), '.cccollab', 'run', `${ZERO_PROFILE}.json`)
  let broker: ChildProcess
  let port: number

  beforeAll(async () => {
    const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
    const brokerPath = fileURLToPath(new URL('../src/broker.ts', import.meta.url))
    broker = spawn(process.execPath, [tsxCli, brokerPath], {
      env: { ...process.env, CCCOLLAB_PROFILE: ZERO_PROFILE, CCCOLLAB_REPLAY_CAPACITY: '1' },
      stdio: 'ignore',
    })
    await waitUntil(() => (existsSync(ZERO_RENDEZVOUS) ? true : null), 10_000)
    port = (JSON.parse(readFileSync(ZERO_RENDEZVOUS, 'utf-8')) as { port: number }).port
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
        unlinkSync(ZERO_RENDEZVOUS)
      } catch {
        /* ignore */
      }
    }
  })

  // Capacity=1: after publishing two events, the buffer holds only the second.
  // A client with a cursor at the FIRST event's seq is behind lastSeq, and the
  // buffer no longer has proof it can hand over the next one — the honest
  // answer is a gap, not a partial replay.
  it('reports a gap when the buffer has evicted the client cursor position', async () => {
    const stream = openStream(port)
    await stream.ready
    const topicId = await seedTopic(port, 'cap-sender', 'cap-ch', 'cap-topic')
    await post(port, `/topics/${topicId}/messages`, { sender: 'cap-sender', text: 'first' })
    await waitUntil(() => (stream.events.some((e) => e.data.text === 'first') ? true : null), 5000)
    const cursor = stream.events[stream.events.length - 1]!.id!
    stream.close()

    // Publish more than the buffer holds, so the cursor's position is evicted.
    await post(port, `/topics/${topicId}/messages`, { sender: 'cap-sender', text: 'second' })
    await post(port, `/topics/${topicId}/messages`, { sender: 'cap-sender', text: 'third' })

    const resumed = openStream(port, cursor)
    await resumed.ready
    await waitUntil(() => (resumed.events.some((e) => e.data.type === 'stream_gap') ? true : null), 5000)
    const gap = resumed.events.find((e) => e.data.type === 'stream_gap')!
    expect(String(gap.data.reason)).toMatch(/behind|evicted/i)
    resumed.close()
  })
})

describe('Broker: replay buffer overflow (KAI-414)', () => {
  const OVERFLOW_PROFILE = `overflowtest-${process.pid}`
  const OVERFLOW_RENDEZVOUS = join(homedir(), '.cccollab', 'run', `${OVERFLOW_PROFILE}.json`)
  let broker: ChildProcess
  let port: number

  beforeAll(async () => {
    const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
    const brokerPath = fileURLToPath(new URL('../src/broker.ts', import.meta.url))
    broker = spawn(process.execPath, [tsxCli, brokerPath], {
      // A 2-event buffer, so falling behind is cheap to reproduce. The capacity
      // is the only thing that changes; the eviction path is the real one.
      env: { ...process.env, CCCOLLAB_PROFILE: OVERFLOW_PROFILE, CCCOLLAB_REPLAY_CAPACITY: '2' },
      stdio: 'ignore',
    })
    await waitUntil(() => (existsSync(OVERFLOW_RENDEZVOUS) ? true : null), 10_000)
    port = (JSON.parse(readFileSync(OVERFLOW_RENDEZVOUS, 'utf-8')) as { port: number }).port
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
        unlinkSync(OVERFLOW_RENDEZVOUS)
      } catch {
        /* ignore */
      }
    }
  })

  // A client that falls further behind than the buffer holds CANNOT be replayed.
  // Silently resuming it from the oldest surviving event would hand it a
  // plausible, incomplete history — the confidently-blind failure, dressed up as
  // a successful reconnect. It must be told instead.
  it('reports a gap rather than a partial replay when the client fell too far behind', async () => {
    const stream = openStream(port)
    await stream.ready
    const topicId = await seedTopic(port, 'evict-sender', 'evict-ch', 'evict-topic')
    await post(port, `/topics/${topicId}/messages`, { sender: 'evict-sender', text: 'm1' })
    await waitUntil(() => (stream.events.some((e) => e.data.text === 'm1') ? true : null), 5000)
    const staleCursor = stream.events[stream.events.length - 1]!.id!
    stream.close()

    // Publish more than the buffer can hold; the cursor's position is evicted.
    for (const text of ['m2', 'm3', 'm4', 'm5']) {
      await post(port, `/topics/${topicId}/messages`, { sender: 'evict-sender', text })
    }

    const resumed = openStream(port, staleCursor)
    await resumed.ready
    await waitUntil(() => (resumed.events.some((e) => e.data.type === 'stream_gap') ? true : null), 5000)
    const gap = resumed.events.find((e) => e.data.type === 'stream_gap')!
    expect(String(gap.data.reason)).toMatch(/behind|evicted/i)
    resumed.close()
  })
})

describe('Broker: SSE replay cursor (KAI-414)', () => {
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
    port = (JSON.parse(readFileSync(RENDEZVOUS, 'utf-8')) as { port: number }).port
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

  it('stamps every event with a resumable id', async () => {
    const stream = openStream(port)
    await stream.ready
    const topicId = await seedTopic(port, 'seq-sender', 'seq-ch', 'seq-topic')
    await post(port, `/topics/${topicId}/messages`, { sender: 'seq-sender', text: 'one' })

    await waitUntil(() => (stream.events.some((e) => e.data.type === 'message') ? true : null), 5000)
    const message = stream.events.find((e) => e.data.type === 'message')!
    expect(message.id).toMatch(/^[0-9a-f-]{36}:\d+$/)
    stream.close()
  })

  it('replays everything published while the client was disconnected', async () => {
    const first = openStream(port)
    await first.ready
    const topicId = await seedTopic(port, 'gap-sender', 'gap-ch', 'gap-topic')
    await post(port, `/topics/${topicId}/messages`, { sender: 'gap-sender', text: 'before the drop' })
    await waitUntil(() => (first.events.some((e) => e.data.text === 'before the drop') ? true : null), 5000)
    const cursor = first.events[first.events.length - 1]!.id!

    // The client goes away. Messages keep being published — this is the window
    // that used to vanish without trace.
    first.close()
    await new Promise<void>((r) => setTimeout(r, 100))
    await post(port, `/topics/${topicId}/messages`, { sender: 'gap-sender', text: 'DURING the gap' })
    await post(port, `/topics/${topicId}/messages`, { sender: 'gap-sender', text: 'also during the gap' })

    const resumed = openStream(port, cursor)
    await resumed.ready
    await waitUntil(() => (resumed.events.some((e) => e.data.text === 'also during the gap') ? true : null), 5000)

    const texts = resumed.events.filter((e) => e.data.type === 'message').map((e) => e.data.text)
    expect(texts).toContain('DURING the gap')
    expect(texts).toContain('also during the gap')
    // And it must not re-deliver what the client already had.
    expect(texts).not.toContain('before the drop')
    resumed.close()
  })

  it('admits a gap when the cursor is from a previous broker instance', async () => {
    // Seed a few events first so lastSeq > 5. Without this, seq=5 would fall
    // into the unrelated `since > lastSeq` branch and the test would pass on
    // the wrong reason — the pre-fix version literally did.
    const topicId = await seedTopic(port, 'reboot-sender', 'reboot-ch', 'reboot-topic')
    for (const text of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await post(port, `/topics/${topicId}/messages`, { sender: 'reboot-sender', text })
    }

    // A cursor with a DIFFERENT brokerId but a seq value the current broker
    // could plausibly have issued — the only way to actually exercise the
    // "restart" branch.
    const resumed = openStream(port, '00000000-0000-4000-8000-000000000000:5')
    await resumed.ready
    await waitUntil(() => (resumed.events.some((e) => e.data.type === 'stream_gap') ? true : null), 5000)

    const gap = resumed.events.find((e) => e.data.type === 'stream_gap')!
    expect(gap.data.source).toBe('local')
    expect(String(gap.data.reason)).toMatch(/previous broker instance/i)
    resumed.close()
  })

  // The quiet-watcher fix: without this, a listener that connects and hears no
  // traffic has NO cursor, so a subsequent drop resumes as a fresh client and
  // silently swallows every event published in the gap. stream_hello hands
  // over a cursor before the first real event exists.
  it('hands a fresh client a resumable cursor before any traffic arrives', async () => {
    const stream = openStream(port)
    await stream.ready
    await waitUntil(() => (stream.events.some((e) => e.data.type === 'stream_hello') ? true : null), 5000)

    const hello = stream.events.find((e) => e.data.type === 'stream_hello')!
    expect(hello.id).toMatch(/^[0-9a-f-]{36}:\d+$/)
    expect(hello.data.source).toBe('local')

    // The hello cursor must be honourable by the same broker instance — a
    // quiet reconnect from it must not produce a gap.
    stream.close()
    const resumed = openStream(port, hello.id!)
    await resumed.ready
    await new Promise<void>((r) => setTimeout(r, 300))
    expect(resumed.events.some((e) => e.data.type === 'stream_gap')).toBe(false)
    resumed.close()
  })

  it('does not claim a gap when the client reconnects with a cursor it can honour', async () => {
    const stream = openStream(port)
    await stream.ready
    const topicId = await seedTopic(port, 'nogap-sender', 'nogap-ch', 'nogap-topic')
    await post(port, `/topics/${topicId}/messages`, { sender: 'nogap-sender', text: 'hello' })
    await waitUntil(() => (stream.events.some((e) => e.data.text === 'hello') ? true : null), 5000)
    const cursor = stream.events[stream.events.length - 1]!.id!
    stream.close()

    const resumed = openStream(port, cursor)
    await resumed.ready
    await new Promise<void>((r) => setTimeout(r, 300))
    expect(resumed.events.some((e) => e.data.type === 'stream_gap')).toBe(false)
    resumed.close()
  })
})
