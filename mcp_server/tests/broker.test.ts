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

  describe('self-declared identity (KAI-401)', () => {
    interface SessionRow {
      name: string
      objective?: string
      registeredAt?: string
      channels?: string[]
      identity?: Record<string, unknown>
    }

    async function getSessions(): Promise<SessionRow[]> {
      const res = await fetch(`http://127.0.0.1:${port}/sessions`)
      const body = (await res.json()) as { sessions: SessionRow[] }
      return body.sessions
    }

    async function postSession(
      name: string,
      identity?: Record<string, unknown>,
      objective?: string,
    ): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...(objective ? { objective } : {}), ...(identity ? { identity } : {}) }),
      })
    }

    it('stores declared identity and returns it in GET /sessions', async () => {
      const identity = {
        company: 'flatout',
        repo: 'cccollab',
        worktree: 'KAI-401',
        branch: 'KAI-401',
        cwd: '/projects/cccollab-KAI-401',
        sessionId: 'uuid-401',
        pid: 4321,
      }
      const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ident-declared', identity }),
      })
      expect(res.status).toBe(200)

      const found = (await getSessions()).find((s) => s.name === 'ident-declared')
      expect(found?.identity).toEqual(identity)
    })

    it('omits identity for sessions that declare none (no breaking change)', async () => {
      await registerSession(port, 'ident-absent')
      const found = (await getSessions()).find((s) => s.name === 'ident-absent')
      expect(found).toBeDefined()
      expect(found).not.toHaveProperty('identity')
    })

    /**
     * There is exactly ONE broker per user, shared by every worktree on the
     * machine, and this project's own orchestration hands out short names
     * like `worker`, `architect`, `reviewer`. `POST /sessions` consults only
     * the request body — never the socket, a token, or a pid — so two
     * unrelated processes that pick the same name were the same record.
     *
     * Rows are removed only by an explicit DELETE issued best-effort on
     * graceful shutdown, so a SIGKILL, a crash, or a closed terminal leaves
     * the previous session's row behind for the next one to land on. None
     * of this needs malice to happen.
     */
    describe('name collisions between unrelated sessions', () => {
      /**
       * The guarantee is about IDENTITY, not about row count. A display name
       * is the only address every non-POST route has, so two live processes
       * that pick the same name necessarily share one record — that is
       * pre-existing and cannot be fixed without a broker-issued handle.
       * Splitting them by declared `sessionId` was tried and reverted: it
       * made a caller-declared, published value address the record space,
       * which is a one-request authorization capture (see the RR-1 test).
       *
       * What must hold either way: a session is never published under
       * another session's sessionId, pid or cwd.
       */
      it('keeps prior identity when a re-introduce omits the identity key (C2)', async () => {
        // Omit is the ordinary rename / objective-only re-introduce. Wiping
        // identity on omit made whoami disagree with the broker mid-session
        // (KAI-401 C2). Name collisions (two live processes, same display
        // name) remain pre-existing: they share one record and therefore
        // also share the kept identity — that needs a broker-issued handle.
        const prior = { sessionId: 'uuid-collide-A', cwd: '/projects/repo-KAI-999', pid: 111_111 }
        await postSession('collide-worker', prior, 'A objective')
        await postSession('collide-worker', undefined, 'B objective')

        const rows = (await getSessions()).filter((s) => s.name === 'collide-worker')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.identity).toEqual(prior)
        expect(rows[0]?.objective).toBe('B objective')
      })

      it('last-write-wins when a re-introduce declares a new identity (I8)', async () => {
        const first = { sessionId: 'uuid-lww-1', company: 'flatout' }
        const second = { sessionId: 'uuid-lww-2', company: 'acme' }
        await postSession('lww-worker', first)
        await postSession('lww-worker', second)

        const row = (await getSessions()).find((s) => s.name === 'lww-worker')
        expect(row?.identity).toEqual(second)
      })

      it('does not let a same-named session publish itself under another session identity', async () => {
        const victim = { sessionId: 'uuid-clobber-A', cwd: '/projects/repo-KAI-999', pid: 111_111 }
        const other = { sessionId: 'uuid-clobber-B', cwd: '/tmp/elsewhere', pid: 999_999 }
        await postSession('clobber-worker', victim, 'A objective')
        await postSession('clobber-worker', other, 'B objective')

        const rows = (await getSessions()).filter((s) => s.name === 'clobber-worker')
        // B publishes B — never A's anchor, and never a mix of the two.
        expect(rows).toHaveLength(1)
        expect(rows[0]?.identity).toEqual(other)
      })

      it('an explicit null identity does not resurrect the previous holder of the name', async () => {
        // `?? ` treats null as nullish, so an explicit null inherited too.
        const victim = { sessionId: 'uuid-null-A', cwd: '/projects/repo-KAI-999' }
        await postSession('null-worker', victim)
        await fetch(`http://127.0.0.1:${port}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'null-worker', identity: null }),
        })

        const rows = (await getSessions()).filter((s) => s.name === 'null-worker')
        expect(rows.some((s) => s.identity === undefined)).toBe(true)
      })

      /**
       * The other half of the contract: keying on the declared id must not
       * split ONE session across two rows. Every route other than
       * `POST /sessions` addresses a session by the name it sends, so those
       * lookups have to resolve to the identity-keyed record — otherwise
       * joining a channel silently mints a second, identity-less row and
       * the session's channels and registration time land on the wrong one.
       */
      it('keeps one row, its channels and its registration time when the same session re-introduces', async () => {
        const ident = { sessionId: 'uuid-reintro', cwd: '/projects/repo' }
        await postSession('reintro-worker', ident, 'first objective')
        await joinChannel(port, 'reintro-worker', 'reintro-ch')
        const before = (await getSessions()).find((s) => s.name === 'reintro-worker')
        expect(before?.channels).toEqual(['reintro-ch'])

        await postSession('reintro-worker', ident, 'second objective')

        const rows = (await getSessions()).filter((s) => s.name === 'reintro-worker')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.objective).toBe('second objective')
        expect(rows[0]?.channels).toEqual(['reintro-ch'])
        expect(rows[0]?.registeredAt).toBe(before?.registeredAt)
      })

      /**
       * The ordinary lifecycle, and the one none of the tests above walk:
       * a session registers under its config name BEFORE it has an identity
       * (server.ts introduces on the local transport at startup, and the
       * agent only calls `introduce` afterwards), joins its channels under
       * that name, and declares an identity on a LATER call.
       *
       * Keying that later call on the declared id while the earlier row
       * stays under the name puts ONE session in TWO rows: the name row
       * holds every channel membership, the id row holds the identity and
       * nothing else. `GET /sessions` then lists the session twice, and
       * every channel-scoped view — which is what `list_sessions` uses —
       * returns the row WITHOUT the identity, so the declared fields are
       * stored but unreachable. KAI-401's acceptance criterion is that they
       * land on "the session record", singular.
       *
       * A registration that declares an id therefore adopts the row already
       * held under its display name, provided that row declared no id of
       * its own. That proviso is what keeps the anti-clobber guarantee
       * above intact: a row that declared a DIFFERENT id is a different
       * session and is never adopted.
       */
      it('adopts the row already held under its name when a session declares an identity later', async () => {
        const ident = { sessionId: 'uuid-late-declare', cwd: '/projects/repo', pid: 4242 }
        await registerSession(port, 'late-worker')
        await joinChannel(port, 'late-worker', 'late-ch')
        const before = (await getSessions()).find((s) => s.name === 'late-worker')
        expect(before?.channels).toEqual(['late-ch'])

        await postSession('late-worker', ident, 'now with identity')

        const rows = (await getSessions()).filter((s) => s.name === 'late-worker')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.identity).toEqual(ident)
        // The membership and the registration time belong to the same
        // session, so they must survive the move to the identity key.
        expect(rows[0]?.channels).toEqual(['late-ch'])
        expect(rows[0]?.registeredAt).toBe(before?.registeredAt)
      })

      it('serves the declared identity from the channel-scoped view after a late declaration', async () => {
        const ident = { sessionId: 'uuid-late-scoped', cwd: '/projects/repo' }
        await registerSession(port, 'late-scoped-worker')
        await joinChannel(port, 'late-scoped-worker', 'late-scoped-ch')
        await postSession('late-scoped-worker', ident)

        // `list_sessions` reads this view; if the identity sits on a second,
        // membership-less row it is invisible to every consumer.
        const res = await fetch(`http://127.0.0.1:${port}/sessions?channel=late-scoped-ch`)
        const rows = ((await res.json()) as { sessions: SessionRow[] }).sessions
        expect(rows).toHaveLength(1)
        expect(rows[0]?.identity).toEqual(ident)
      })

      it('leaves nothing behind when a session that declared an identity late shuts down', async () => {
        const ident = { sessionId: 'uuid-late-delete', cwd: '/projects/repo' }
        await registerSession(port, 'late-delete-worker')
        await joinChannel(port, 'late-delete-worker', 'late-delete-ch')
        await postSession('late-delete-worker', ident)

        const res = await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent('late-delete-worker')}`, {
          method: 'DELETE',
        })
        expect(res.status).toBe(200)

        // A split leaves the id-keyed row orphaned in the broker forever:
        // DELETE addresses the session by name and removes only one row.
        expect((await getSessions()).filter((s) => s.name === 'late-delete-worker')).toHaveLength(0)
      })

      /**
       * RR-1. The broker is unauthenticated loopback and `GET /sessions`
       * publishes every display name, so a declared value must never be able
       * to ADDRESS another session's record. Keying sessions on the
       * caller-declared `sessionId` in the same map that holds name-keyed
       * sessions let one local process send a single request naming a
       * victim's display name as its own `sessionId`, inherit the victim's
       * channel authorization under its own name, and delete the victim's
       * row in the process — invisibly.
       */
      it('refuses a declared sessionId that names another session (no authorization capture)', async () => {
        await registerSession(port, 'rr1-architect')
        await joinChannel(port, 'rr1-architect', 'rr1-private')
        // Control: the attacker cannot post to the private channel yet.
        expect((await broadcast(port, 'rr1-mallory', 'rr1-private', 'probe')).status).toBe(400)

        await postSession('rr1-mallory', { sessionId: 'rr1-architect', cwd: '/tmp/attacker', pid: 9 })

        // ...and still cannot after declaring the victim's name as its id.
        expect((await broadcast(port, 'rr1-mallory', 'rr1-private', 'captured')).status).toBe(400)
        const rows = await getSessions()
        // The victim is untouched: same row, same membership, no rename.
        expect(rows.find((s) => s.name === 'rr1-architect')?.channels).toEqual(['rr1-private'])
        // ...and the channel has exactly its one real member, not a phantom.
        expect(await listChannels(port, 'rr1-architect')).toEqual([
          { name: 'rr1-private', subscriberCount: 1, sessionCount: 1 },
        ])
      })

      /**
       * RR-2. Every route except `POST /sessions` addresses a session by the
       * display name it sends — that is all it has. If a declaring session
       * lives under its declared id while a non-declaring one lives under
       * the name, the non-declaring one wins every name lookup and the
       * declaring one becomes unreachable by name: it keeps reporting its
       * channels through `whoami` while the broker refuses its messages.
       */
      it('keeps a declaring session reachable by name when a later same-named session declares none', async () => {
        await postSession('rr2-worker', { sessionId: 'uuid-rr2-A', cwd: '/worktrees/a' })
        await joinChannel(port, 'rr2-worker', 'rr2-ops')
        expect((await broadcast(port, 'rr2-worker', 'rr2-ops', 'from A')).status).toBe(200)

        // A second worktree boots under the same short name, declaring nothing.
        await registerSession(port, 'rr2-worker')

        expect((await broadcast(port, 'rr2-worker', 'rr2-ops', 'still reachable')).status).toBe(200)
      })

      /**
       * RR-4. A re-introduce that omits identity must not move the session
       * to a different key: that splits it into two rows, hides its own
       * channel from it, and orphans the membership on a row that DELETE
       * (which addresses by name) will never reach — for the lifetime of the
       * broker, which has no idle timeout.
       */
      it('does not split a session when a re-introduce omits identity', async () => {
        await postSession('rr4-dup', { sessionId: 'uuid-rr4' })
        await joinChannel(port, 'rr4-dup', 'rr4-chan')

        await postSession('rr4-dup')

        expect((await getSessions()).filter((s) => s.name === 'rr4-dup')).toHaveLength(1)
        // The session can still see its own channel.
        expect((await listChannels(port, 'rr4-dup')).map((c) => c.name)).toEqual(['rr4-chan'])

        await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent('rr4-dup')}`, { method: 'DELETE' })
        expect((await getSessions()).filter((s) => s.name === 'rr4-dup')).toHaveLength(0)
      })

      /**
       * C5 / I8. The MCP schema never runs here: `POST /sessions` is raw
       * HTTP on an unauthenticated loopback port, and the handler asserts a
       * TypeScript type onto `JSON.parse` output rather than validating it.
       * Whatever arrives is stored and then re-served to every other session
       * through `GET /sessions`, typed as `SessionIdentity` — so a consumer
       * that trusts the declared type gets a number where it expects a
       * string. Validate the boundary instead of asserting it.
       */
      it('stores only well-typed identity fields from the unauthenticated wire', async () => {
        await postSession('c5-typed', {
          company: 'flatout',
          repo: 42,
          pid: 'nine',
          sessionId: 'uuid-c5',
          junkField: { nested: true },
        })

        const row = (await getSessions()).find((s) => s.name === 'c5-typed')
        expect(row?.identity).toEqual({ company: 'flatout', sessionId: 'uuid-c5' })
      })

      it('ignores an identity that is not an object at all', async () => {
        await fetch(`http://127.0.0.1:${port}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'c5-scalar', identity: 'not-an-object' }),
        })

        const row = (await getSessions()).find((s) => s.name === 'c5-scalar')
        expect(row).toBeDefined()
        expect(row).not.toHaveProperty('identity')
      })

      it('drops a sessionId that is a path rather than an identifier', async () => {
        await postSession('c5-path', { sessionId: '../../../../tmp/pwn', company: 'flatout' })

        const row = (await getSessions()).find((s) => s.name === 'c5-path')
        // The rest of the identity is still honest data; only the unusable
        // key is refused, and it must not be republished to other sessions.
        expect(row?.identity).toEqual({ company: 'flatout' })
      })

      it('unregisters an identity-declaring session by the name it registered under', async () => {
        const ident = { sessionId: 'uuid-delete', cwd: '/projects/repo' }
        await postSession('delete-worker', ident)
        expect((await getSessions()).some((s) => s.name === 'delete-worker')).toBe(true)

        const res = await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent('delete-worker')}`, {
          method: 'DELETE',
        })
        expect(res.status).toBe(200)

        expect((await getSessions()).some((s) => s.name === 'delete-worker')).toBe(false)
      })
    })
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
    async function readHistory(
      topicId: string,
      query: { limit?: number; before?: number } = {},
    ): Promise<{
      status: number
      body: { messages: Array<{ sender: string; text: string; ts: number }>; hasMore: boolean }
    }> {
      const params = new URLSearchParams()
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
      const { status, body } = await readHistory(id)
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
      const { status, body } = await readHistory(id)
      expect(status).toBe(200)
      expect(body.messages).toEqual([])
      expect(body.hasMore).toBe(false)
    })

    it('caps the page to `limit`, returns the newest page, and sets hasMore', async () => {
      const id = await seed('hist-b', 'hist-b-ch', 'hist-topic-b', ['m1', 'm2', 'm3', 'm4', 'm5'], 2)
      const { body } = await readHistory(id, { limit: 2 })
      // Newest two, still oldest-first within the page.
      expect(body.messages.map((m) => m.text)).toEqual(['m4', 'm5'])
      expect(body.hasMore).toBe(true)
    })

    it('pages backwards with the `before` cursor until hasMore is false', async () => {
      const id = await seed('hist-c', 'hist-c-ch', 'hist-topic-c', ['a', 'b', 'c', 'd'], 2)
      const first = await readHistory(id, { limit: 2 })
      expect(first.body.messages.map((m) => m.text)).toEqual(['c', 'd'])
      expect(first.body.hasMore).toBe(true)

      const cursor = first.body.messages[0]!.ts
      const second = await readHistory(id, { limit: 2, before: cursor })
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
})
