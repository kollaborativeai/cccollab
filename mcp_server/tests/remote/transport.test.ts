import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ConvexClient } from 'convex/browser'
import { getFunctionName } from 'convex/server'

import { RemoteTransport, HEARTBEAT_INTERVAL_MS, DEGRADATION_WINDOW_MS } from '../../src/transport/remote.js'

/**
 * Self-disable / per-tool-skip transition tests.
 *
 * The `RemoteTransport` graceful-degradation policy operates at two levels:
 *
 * - Transport-wide `enabled = false`: only on a structured auth failure, or
 *   immediately on a `FunctionNotFoundError` from a long-lived subscription
 *   (structural schema drift on a core reactive feed — genuinely a
 *   transport-wide signal).
 * - Per-tool skip: everything else — including 3+ failures of the SAME op
 *   within the 60s window, or a single `FunctionNotFoundError` from a
 *   one-shot op — is tracked per op name. Once a specific op crosses the
 *   threshold, THAT op alone is skipped (short-circuited without reaching
 *   the backend) while every other op on the same transport keeps working
 *   normally (KAI-333: a specific dead/failing tool must be skipped, not
 *   disable the shared connection for every other tool).
 *
 * We construct a minimal ConvexClient stub whose `query` method rejects
 * with the relevant error. That's enough to exercise the transition inside
 * `listChannels()` / `listOrganizations()`.
 */

class SchemaDriftError extends Error {
  constructor(message: string) {
    super(message)
    // Name must match RemoteTransport's FunctionNotFoundError detector.
    this.name = 'FunctionNotFoundError'
  }
}

interface StubClientHandle {
  client: ConvexClient
  queryMock: ReturnType<typeof vi.fn>
  mutationMock: ReturnType<typeof vi.fn>
}

function makeStubClient(
  queryImpl: (...args: unknown[]) => Promise<unknown>,
  mutationImpl?: (...args: unknown[]) => Promise<unknown>,
): StubClientHandle {
  // Only the methods RemoteTransport touches need to exist. The rest of
  // ConvexClient's surface isn't relevant to this test. Cast through
  // `unknown` to satisfy the structural type without importing the
  // whole client.
  const queryMock = vi.fn(queryImpl)
  const mutationMock = vi.fn(mutationImpl ?? (async () => undefined))
  const stub = {
    query: queryMock,
    mutation: mutationMock,
    onUpdate: vi.fn(() => () => {}),
    setAuth: vi.fn(),
  }
  return { client: stub as unknown as ConvexClient, queryMock, mutationMock }
}

describe('RemoteTransport graceful degradation', () => {
  it('does NOT disable on a single function-not-found from a one-shot op; only that op returns empty', async () => {
    const { client, queryMock } = makeStubClient(async () => {
      throw new SchemaDriftError('Could not find function channels:listAll on deployment')
    })
    const log: string[] = []
    const transport = new RemoteTransport({ client, log: (m) => log.push(m) })

    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()

    // A single missing function fails just this op (empty result). The
    // transport stays enabled so every other op keeps working — one stale
    // tool bound to a removed backend function no longer bricks the whole
    // remote transport (KAI-333).
    const first = await transport.listChannels({})
    expect(first).toEqual([])
    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()

    // Not short-circuited: a subsequent call still reaches the client.
    const callsBefore = queryMock.mock.calls.length
    await transport.listChannels({})
    expect(queryMock.mock.calls.length).toBe(callsBefore + 1)
  })

  it('after three function-not-found errors, ONLY that op is skipped — the transport stays enabled (KAI-333 finding #2)', async () => {
    const { client, queryMock } = makeStubClient(async () => {
      throw new SchemaDriftError('Could not find function channels:listAll on deployment')
    })
    const transport = new RemoteTransport({ client, log: () => {} })

    await transport.listChannels({})
    await transport.listChannels({})
    await transport.listChannels({})
    // Transport-wide switch is untouched: repeated failures of one tool
    // must not brick every other tool sharing this transport.
    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()

    // The 4th call is short-circuited: `listChannels` is now skipped, so
    // it never reaches the backend again.
    const callsBeforeSkip = queryMock.mock.calls.length
    const result = await transport.listChannels({})
    expect(result).toEqual([])
    expect(queryMock.mock.calls.length).toBe(callsBeforeSkip)
  })

  it('after three generic failures of the same op, ONLY that op is skipped — the transport stays enabled (KAI-333 finding #2)', async () => {
    let counter = 0
    const { client, queryMock } = makeStubClient(async () => {
      counter += 1
      throw new Error(`network blip ${counter}`)
    })
    const transport = new RemoteTransport({ client, log: () => {} })

    await transport.listChannels({})
    await transport.listChannels({})
    await transport.listChannels({})
    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()

    const callsBeforeSkip = queryMock.mock.calls.length
    const result = await transport.listChannels({})
    expect(result).toEqual([])
    expect(queryMock.mock.calls.length).toBe(callsBeforeSkip)
  })

  it('a tool tripped into skip-state does not affect a DIFFERENT tool on the same transport (KAI-333 finding #2)', async () => {
    // Samuel's exact framing: "it shouldn't get disabled it should be
    // skipped" — a specific dead/failing tool (listChannels here) must be
    // skipped on its own while every OTHER tool (listOrganizations) keeps
    // working normally on the same transport.
    let listChannelsCalls = 0
    const { client } = makeStubClient(async (ref: unknown) => {
      const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
      if (name === 'cccollab/channels:listAll') {
        listChannelsCalls += 1
        throw new Error(`network blip ${listChannelsCalls}`)
      }
      if (name === 'cccollab/organizations:listForUser') {
        return [{ id: 'org_a', name: 'Acme' }]
      }
      return []
    })
    const transport = new RemoteTransport({ client, log: () => {} })

    // A tool retried 3x within the window used to brick the whole
    // transport — now it just skips itself.
    await transport.listChannels({})
    await transport.listChannels({})
    await transport.listChannels({})
    expect(transport.enabled).toBe(true)

    const callsBeforeSkip = listChannelsCalls
    await transport.listChannels({})
    expect(listChannelsCalls).toBe(callsBeforeSkip) // short-circuited

    // A different tool, never having failed, is completely unaffected.
    const orgs = await transport.listOrganizations()
    expect(orgs).toEqual([{ id: 'org_a', name: 'Acme' }])
  })

  it('trips immediately on a ConvexError with code UNAUTHENTICATED (structured auth signal)', async () => {
    // Our convex/utils/auth.ts throws `ConvexError({code: "UNAUTHENTICATED", ...})`
    // via authenticatedQuery/authenticatedMutation. The serialised error
    // surfaces on the client as `err.data = {code, message}`. The auth-
    // error detector must prefer this structured signal over any text
    // pattern.
    class ConvexAuthError extends Error {
      readonly data = { code: 'UNAUTHENTICATED', message: 'Sign-in required.' }
      constructor() {
        super('Convex error: Sign-in required.')
      }
    }
    const { client } = makeStubClient(async () => {
      throw new ConvexAuthError()
    })
    const transport = new RemoteTransport({ client, log: () => {} })

    await transport.listChannels({})
    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/authentication failed/i)
  })

  it('trips immediately on an Error named UnauthenticatedError', async () => {
    class UnauthenticatedError extends Error {
      constructor() {
        super('Some opaque message')
        this.name = 'UnauthenticatedError'
      }
    }
    const { client } = makeStubClient(async () => {
      throw new UnauthenticatedError()
    })
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.listChannels({})
    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/authentication failed/i)
  })

  it('falls back to message regex for bare auth errors that lack structured fields', async () => {
    const { client } = makeStubClient(async () => {
      throw new Error('Token has expired, please re-authenticate.')
    })
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.listChannels({})
    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/authentication failed/i)
  })

  it('a function-not-found on a long-lived subscription DOES disable the whole transport (structural drift stays strict — unlike per-tool skip)', () => {
    // Counterpart to the per-tool-skip cases above: a missing CORE feed
    // function (listByTopic/listByChannel) on a reactive subscription is
    // genuine schema drift, not a stray tool. This is the one case that
    // deliberately stays a transport-wide trip (alongside auth failure) —
    // it must still trip the breaker so the user gets the "restart your
    // session" signal instead of silent partial sync.
    let onError: ((err: unknown) => void) | undefined
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => undefined),
      onUpdate: vi.fn(
        (
          _query: unknown,
          _args: Record<string, unknown>,
          _onNext: (rows: unknown) => void,
          onErr: (err: unknown) => void,
        ) => {
          onError = onErr
          return () => {}
        },
      ),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})
    expect(transport.enabled).toBe(true)

    onError!(new SchemaDriftError('Could not find function messages:listByTopic on deployment'))
    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/function not found/i)
  })

  it('a function-not-found on a channel reactive subscription also disables the transport (cc#30 I8)', async () => {
    // Topic path above is covered; channel listByChannel must trip the same way.
    let onError: ((err: unknown) => void) | undefined
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        if ('sessionName' in args) return 'session_1'
        if ('channel' in args && 'sessionId' in args && !('text' in args)) {
          return { channelId: 'chan_dev', latestTs: 0 }
        }
        return undefined
      }),
      onUpdate: vi.fn(
        (
          _query: unknown,
          _args: Record<string, unknown>,
          _onNext: (rows: unknown) => void,
          onErr: (err: unknown) => void,
        ) => {
          onError = onErr
          return () => {}
        },
      ),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    await transport.introduce({ sessionName: 'laptop' })
    await transport.joinChannel({ sessionName: 'laptop', channel: 'dev' })
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    expect(transport.enabled).toBe(true)
    onError!(new SchemaDriftError('Could not find function messages:listByChannel on deployment'))
    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/function not found/i)
  })

  it('detects FunctionNotFound by error name alone and by message alone (cc#30 S2)', async () => {
    // SchemaDriftError sets both; half-deletion of either arm must not go untested.
    class NameOnly extends Error {
      constructor() {
        super('opaque')
        this.name = 'FunctionNotFoundError'
      }
    }
    class MessageOnly extends Error {
      constructor() {
        super('Could not find function channels:listAll on deployment')
        this.name = 'Error'
      }
    }
    for (const factory of [() => new NameOnly(), () => new MessageOnly()]) {
      const { client } = makeStubClient(async () => {
        throw factory()
      })
      const transport = new RemoteTransport({ client, log: () => {} })
      // One-shot FNF must NOT brick the transport (per-op path).
      await transport.listChannels({})
      expect(transport.enabled).toBe(true)
      expect(transport.degradation).toBeNull()
    }
  })
})

/**
 * `subscribeTopicMessages` should pass a `sinceTs` to the reactive
 * `listByTopic` query on re-subscribe so Convex narrows results to
 * messages newer than what we've already delivered. The per-topic
 * watermark (`topicMaxTs`) must persist across unsubscribe/resubscribe
 * so a reconnect after leave-topic/join-topic still benefits.
 */
describe('RemoteTransport.subscribeTopicMessages sinceTs windowing', () => {
  it('omits sinceTs on first subscribe and passes the running max on a resubscribe', () => {
    // Capture every `onUpdate` call's args so we can assert the second
    // subscribe received sinceTs === the max ts delivered by the first.
    const onUpdateCalls: Array<{ query: unknown; args: Record<string, unknown> }> = []
    const callbacks: Array<(rows: unknown) => void> = []
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => undefined),
      onUpdate: vi.fn((query: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void) => {
        onUpdateCalls.push({ query, args })
        callbacks.push(cb)
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    const delivered: Array<{ ts: string; text: string }> = []
    const onEvent = (msg: { ts: string; text: string }) => delivered.push(msg)

    const unsub1 = transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, onEvent)
    // Simulate Convex delivering two messages.
    callbacks[0]!([
      { _id: 'msg_1', fromSessionId: 'alice', text: 'first', ts: 1_700_000_100_000 },
      { _id: 'msg_2', fromSessionId: 'alice', text: 'second', ts: 1_700_000_200_000 },
    ])
    expect(delivered).toHaveLength(2)
    expect(onUpdateCalls[0]!.args).toEqual({ topicId: 't1' })

    unsub1()

    // Resubscribe: sinceTs must be the highest ts seen so far.
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, onEvent)
    expect(onUpdateCalls[1]!.args).toEqual({ topicId: 't1', sinceTs: 1_700_000_200_000 })

    // A message with a newer ts on the resubscribed stream advances the
    // watermark; a message at or below the prior watermark is filtered
    // client-side via the id-dedup set (the second subscribe gets a fresh
    // BoundedIdSet, so the "dup" id is treated as new — but if it's the
    // same ts we already had plus a new content, it'd still be surfaced).
    callbacks[1]!([
      { _id: 'msg_3', fromSessionId: 'alice', text: 'third', ts: 1_700_000_300_000 },
      { _id: 'msg_2', fromSessionId: 'alice', text: 'second', ts: 1_700_000_200_000 },
    ])
    // Only `third` is delivered because the `_id` dedup inside the second
    // subscription has seen msg_2 in its own Set when it arrived first.
    // Wait — second subscription has a FRESH Set. So msg_2 WOULD be
    // re-delivered via the server's inclusive cursor. That's the expected
    // same-ms-safety behavior; assertion below accepts either.
    // Assert: `third` is delivered. `msg_2` may or may not be redelivered
    // depending on whether the second subscription's Set has seen it yet.
    expect(delivered.some((d) => d.text === 'third')).toBe(true)
  })

  it('dedupes same-ms messages delivered in a single onUpdate callback', () => {
    // Same-millisecond messages must both be delivered exactly once.
    // Before the fix: the second was silently dropped because the client
    // filtered on `row.ts <= lastTs` and lastTs equalled row.ts after
    // processing the first.
    const onUpdateCalls: Array<{ query: unknown; args: Record<string, unknown> }> = []
    const callbacks: Array<(rows: unknown) => void> = []
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => undefined),
      onUpdate: vi.fn((query: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void) => {
        onUpdateCalls.push({ query, args })
        callbacks.push(cb)
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    const delivered: Array<{ text: string }> = []
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, (msg) => delivered.push({ text: msg.text }))

    // Two inserts in the same millisecond.
    callbacks[0]!([
      { _id: 'msg_a', fromSessionId: 'alice', text: 'a', ts: 1_700_000_000_000 },
      { _id: 'msg_b', fromSessionId: 'alice', text: 'b', ts: 1_700_000_000_000 },
    ])

    expect(delivered.map((d) => d.text).sort()).toEqual(['a', 'b'])
  })

  it('dedupes the same message arriving twice in subsequent onUpdate callbacks (no duplicate delivery)', () => {
    // Convex's `onUpdate` fires with the full result set for each update.
    // On every new-message tick, the server re-sends all rows matching the
    // current sinceTs window. The client must not re-deliver rows it has
    // already surfaced.
    const callbacks: Array<(rows: unknown) => void> = []
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => undefined),
      onUpdate: vi.fn((_q: unknown, _args: Record<string, unknown>, cb: (rows: unknown) => void) => {
        callbacks.push(cb)
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    const delivered: Array<{ text: string }> = []
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, (msg) => delivered.push({ text: msg.text }))

    callbacks[0]!([{ _id: 'msg_1', fromSessionId: 'alice', text: 'a', ts: 1_700_000_000_000 }])
    // Second tick: Convex re-sends all rows plus a new one.
    callbacks[0]!([
      { _id: 'msg_1', fromSessionId: 'alice', text: 'a', ts: 1_700_000_000_000 },
      { _id: 'msg_2', fromSessionId: 'alice', text: 'b', ts: 1_700_000_100_000 },
    ])

    expect(delivered.map((d) => d.text)).toEqual(['a', 'b'])
  })
})

describe('RemoteTransport.introduce rethrow', () => {
  it('rethrows transient errors so attach.ts can abort before registering', async () => {
    // If introduce() swallows the error, attach.ts's try/catch never fires
    // and the caller ends up with a half-wired transport where sessionId
    // is null — subsequent tool calls silently no-op. Rethrow preserves
    // the safety contract.
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => {
        throw new Error('network glitch')
      }),
      onUpdate: vi.fn(),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    await expect(transport.introduce({ sessionName: 'laptop' })).rejects.toThrow(/network glitch|introduce/)
    expect((transport as unknown as { sessionId: string | null }).sessionId).toBeNull()
  })

  it('rethrow does not bypass the failure counter — three failures skip ONLY "introduce", not the whole transport', async () => {
    let calls = 0
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => {
        calls++
        throw new Error(`call ${calls}`)
      }),
      onUpdate: vi.fn(),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    for (let i = 0; i < 3; i++) {
      await expect(transport.introduce({ sessionName: 'laptop' })).rejects.toThrow()
    }
    // Transport-wide switch is untouched — three failures of one tool
    // (even one that rethrows) must not brick every other tool.
    expect(transport.enabled).toBe(true)

    // The 4th call is short-circuited: `introduce` is now skipped, so the
    // mutation is never reached again.
    const callsBeforeSkip = calls
    await expect(transport.introduce({ sessionName: 'laptop' })).rejects.toThrow(/skipped/i)
    expect(calls).toBe(callsBeforeSkip)
  })

  it('introduce on a skipped op throws rather than silently no-op', async () => {
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => {
        throw new Error('perm error')
      }),
      onUpdate: vi.fn(),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    // Trip `introduce`'s per-op skip state.
    for (let i = 0; i < 3; i++) {
      await transport.introduce({ sessionName: 'x' }).catch(() => {})
    }
    expect(transport.enabled).toBe(true)
    // A subsequent introduce must not silently succeed.
    await expect(transport.introduce({ sessionName: 'x' })).rejects.toThrow(/skipped/i)
  })
})

describe('RemoteTransport write/join skip fails closed (cc#30 C1)', () => {
  async function introduceReady(
    mutationImpl: (...args: unknown[]) => Promise<unknown>,
  ): Promise<{ transport: RemoteTransport; mutationMock: ReturnType<typeof vi.fn> }> {
    const { client, mutationMock } = makeStubClient(async () => [], mutationImpl)
    const transport = new RemoteTransport({ client, log: () => {} })
    mutationMock.mockImplementationOnce(async () => 'session_1')
    await transport.introduce({ sessionName: 'laptop' })
    mutationMock.mockClear()
    mutationMock.mockImplementation(mutationImpl)
    return { transport, mutationMock }
  }

  it('after three broadcast blips, a 4th broadcast THROWS while transport stays healthy and skippedOps is visible', async () => {
    let calls = 0
    const { transport, mutationMock } = await introduceReady(async () => {
      calls += 1
      throw new Error(`network blip ${calls}`)
    })

    for (let i = 0; i < 3; i++) {
      await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'hi' })
    }
    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()
    expect(transport.skippedOps.map((s) => s.op)).toContain('broadcast')

    const before = mutationMock.mock.calls.length
    await expect(transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'hi' })).rejects.toThrow(/skipped/i)
    expect(mutationMock.mock.calls.length).toBe(before)
    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()
  })

  it('after three joinChannel blips, a 4th join THROWS rather than soft-returning subscriberCount 0', async () => {
    let calls = 0
    const { transport, mutationMock } = await introduceReady(async () => {
      calls += 1
      throw new Error(`join blip ${calls}`)
    })
    for (let i = 0; i < 3; i++) {
      await transport.joinChannel({ sessionName: 'laptop', channel: 'dev' })
    }
    const before = mutationMock.mock.calls.length
    await expect(transport.joinChannel({ sessionName: 'laptop', channel: 'dev' })).rejects.toThrow(/skipped/i)
    expect(mutationMock.mock.calls.length).toBe(before)
  })

  it('a successful op clears the failure window so intermittent blips do not permanent-mute (cc#30 I3)', async () => {
    let calls = 0
    const { transport, mutationMock } = await introduceReady(async () => {
      calls += 1
      // fail, fail, succeed, fail — without success-clear the 4th would skip
      if (calls === 3) return undefined
      throw new Error(`blip ${calls}`)
    })
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'a' })
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'b' })
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'c' }) // success
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'd' }) // fail again
    expect(transport.skippedOps.map((s) => s.op)).not.toContain('broadcast')
    // Still reaches the backend (not skipped).
    const before = mutationMock.mock.calls.length
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'e' })
    expect(mutationMock.mock.calls.length).toBe(before + 1)
  })

  it('two failures do not skip (threshold floor, cc#30 I8)', async () => {
    let calls = 0
    const { transport, mutationMock } = await introduceReady(async () => {
      calls += 1
      throw new Error(`blip ${calls}`)
    })
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'a' })
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'b' })
    expect(transport.skippedOps).toEqual([])
    const before = mutationMock.mock.calls.length
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'c' })
    expect(mutationMock.mock.calls.length).toBe(before + 1)
  })

  it('failures outside the rolling window do not count toward skip (window expiry, cc#30 I8)', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const { transport, mutationMock } = await introduceReady(async () => {
        calls += 1
        throw new Error(`blip ${calls}`)
      })
      // Two failures near t=0.
      await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'a' })
      await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'b' })
      // Past the window the early failures must age out.
      await vi.advanceTimersByTimeAsync(DEGRADATION_WINDOW_MS + 1)
      await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'c' })
      expect(transport.skippedOps.map((s) => s.op)).not.toContain('broadcast')
      // Still only one failure inside the window — a fourth call still reaches backend.
      const before = mutationMock.mock.calls.length
      await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'd' })
      expect(mutationMock.mock.calls.length).toBe(before + 1)
      expect(transport.skippedOps.map((s) => s.op)).not.toContain('broadcast')
    } finally {
      vi.useRealTimers()
    }
  })

  it('one failure each on three different ops never skips any of them (multi-op isolation, cc#30 I8)', async () => {
    const { client, mutationMock } = makeStubClient(
      async () => [],
      async (ref: unknown) => {
        const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
        if (name === 'cccollab/sessions:introduce') return 'session_1'
        throw new Error(`fail ${name}`)
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'laptop' })
    // 1 failure per op — must not trip any skip (threshold is 3 of the SAME op).
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'x' }).catch(() => {})
    await transport.joinChannel({ sessionName: 'laptop', channel: 'dev' })
    await transport.sendTopicMessage({ sessionName: 'laptop', topicId: 't1', text: 'y' }).catch(() => {})
    // broadcast and sendTopicMessage throw only when skipped; join soft-returns.
    // None should be in skippedOps.
    expect(transport.skippedOps).toEqual([])
    expect(transport.enabled).toBe(true)
    const before = mutationMock.mock.calls.length
    // A second broadcast still reaches the backend (only 1 prior failure).
    await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'z' }).catch(() => {})
    expect(mutationMock.mock.calls.length).toBeGreaterThan(before)
  })

  it('joinTopic history-query failure does not permanent-mute future joins (cc#30 I6)', async () => {
    let joinCalls = 0
    const { client, mutationMock, queryMock } = makeStubClient(
      async (ref: unknown) => {
        const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
        if (name === 'cccollab/messages:listByTopic') throw new Error('history down')
        return []
      },
      async (ref: unknown) => {
        const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
        if (name === 'cccollab/sessions:introduce') return 'session_1'
        if (name === 'cccollab/topics:join') {
          joinCalls += 1
          return { topicId: 't1', channelId: 'c1', name: 'plan' }
        }
        return undefined
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'laptop' })
    // Three joinTopic calls: join mutation succeeds, history fails — must NOT skip.
    for (let i = 0; i < 3; i++) {
      const res = await transport.joinTopic({ sessionName: 'laptop', topicId: 't1' })
      expect(res.history).toEqual([])
    }
    expect(transport.skippedOps.map((s) => s.op)).not.toContain('joinTopic')
    const joinsBefore = joinCalls
    await transport.joinTopic({ sessionName: 'laptop', topicId: 't1' })
    expect(joinCalls).toBe(joinsBefore + 1)
    void mutationMock
    void queryMock
  })

  it('successful introduce clears permanent skips (recovery, cc#30 I2)', async () => {
    const { client } = makeStubClient(
      async () => [],
      async (ref: unknown) => {
        const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
        if (name === 'cccollab/sessions:introduce') return 'session_1'
        if (name === 'cccollab/messages:sendToChannel') throw new Error('send blip')
        return undefined
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'laptop' })
    for (let i = 0; i < 3; i++) {
      await transport.broadcast({ sessionName: 'laptop', channel: 'dev', text: 'x' })
    }
    expect(transport.skippedOps.map((s) => s.op)).toContain('broadcast')
    // Re-introduce succeeds and clears skips.
    await transport.introduce({ sessionName: 'laptop' })
    expect(transport.skippedOps).toEqual([])
  })
})

describe('RemoteTransport.createTopic skip state', () => {
  it('three failures skip ONLY createTopic — a 4th call throws without reaching the mutation, other ops keep working', async () => {
    let createCalls = 0
    const { client } = makeStubClient(
      async (ref: unknown) => {
        const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
        if (name === 'cccollab/organizations:listForUser') return [{ id: 'org_a', name: 'Acme' }]
        return []
      },
      async (ref: unknown) => {
        const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
        if (name === 'cccollab/sessions:introduce') return 'session_1'
        if (name === 'cccollab/topics:start') {
          createCalls += 1
          throw new Error(`network blip ${createCalls}`)
        }
        return undefined
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'laptop' })

    for (let i = 0; i < 3; i++) {
      await expect(transport.createTopic({ sessionName: 'laptop', channel: 'dev', topic: 'plan' })).rejects.toThrow()
    }
    expect(transport.enabled).toBe(true)

    // 4th call is short-circuited: never reaches the mutation again.
    const callsBeforeSkip = createCalls
    await expect(transport.createTopic({ sessionName: 'laptop', channel: 'dev', topic: 'plan-2' })).rejects.toThrow(
      /skipped/i,
    )
    expect(createCalls).toBe(callsBeforeSkip)

    // A different tool on the same transport is unaffected.
    const orgs = await transport.listOrganizations()
    expect(orgs).toEqual([{ id: 'org_a', name: 'Acme' }])
  })
})

describe('RemoteTransport — organizations', () => {
  it('listOrganizations returns the rows from the listForUser query', async () => {
    const { client } = makeStubClient(async () => [
      { id: 'org_a', name: 'Acme' },
      { id: 'org_b', name: 'Beta' },
    ])
    const transport = new RemoteTransport({ client, log: () => {} })
    const orgs = await transport.listOrganizations()
    expect(orgs).toEqual([
      { id: 'org_a', name: 'Acme' },
      { id: 'org_b', name: 'Beta' },
    ])
  })

  it('introduce forwards organizationId to the introduce mutation', async () => {
    const { client, mutationMock } = makeStubClient(
      async () => [], // query: listJoinedForUser preload returns empty array
      async () => 'session_1', // mutation: introduce returns a session id
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'reviewer', organizationId: 'org_a' })
    expect(mutationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionName: 'reviewer', organizationId: 'org_a' }),
    )
  })

  it('getBoundOrganizationName returns the org name from getSessionContext', async () => {
    let queryCallCount = 0
    const { client } = makeStubClient(
      async () => {
        queryCallCount++
        if (queryCallCount === 1) return [] // introduce's listJoinedForUser preload
        return { sessionName: 'reviewer', organizationName: 'Acme' } // getSessionContext
      },
      async () => 'session_1', // introduce mutation
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'reviewer', organizationId: 'org_a' })
    expect(await transport.getBoundOrganizationName()).toBe('Acme')
  })
})

describe('RemoteTransport.subscribeChannelMessages with server-side ack cursor', () => {
  it('keeps the transport enabled when ackChannel fails (fire-and-forget, non-degrading)', async () => {
    // Regression guard: earlier we caught ackChannel failures via
    // `registerFailure`, which treats UNAUTHENTICATED as "permanent"
    // and flips the whole transport off. A transient auth hiccup on a
    // fire-and-forget ack then killed channel + DM + topic delivery
    // for the session. Ack is best-effort; its failure must not
    // degrade.
    const callbacks: Array<(rows: unknown) => void> = []
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        // introduce/join succeed; ackChannel rejects with
        // UNAUTHENTICATED (structured ConvexError-like object).
        if ('sessionName' in args) return 'session_1'
        if ('channel' in args && 'sessionId' in args && !('text' in args)) {
          return { channelId: 'chan_dev' }
        }
        // ackChannel path: { sessionId, channelId, ts }
        const err: Error & { data?: { code: string; message: string } } = new Error('Sign-in required.')
        err.data = { code: 'UNAUTHENTICATED', message: 'Sign-in required.' }
        throw err
      }),
      onUpdate: vi.fn((_q: unknown, _args: Record<string, unknown>, cb: (rows: unknown) => void) => {
        callbacks.push(cb)
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    await transport.introduce({ sessionName: 'laptop' })
    await transport.joinChannel({ sessionName: 'laptop', channel: 'dev' })
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})

    callbacks[0]!([{ _id: 'm1', fromSessionId: 'alice', text: 'hi', ts: 1 }])
    // Let the fire-and-forget mutation settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.enabled).toBe(true)
  })

  it('passes sessionId to listByChannel and ackChannel mutates with the highest ts of each batch', async () => {
    // Bug D fix: restart-replay duplicate suppression via
    // server-side per-session cursor. The reactive subscribe must
    // thread `sessionId` into `listByChannel`, and each delivered
    // batch must trigger an `ackChannel` mutation that advances the
    // cursor to the highest ts just seen.
    const onUpdateCalls: Array<{ args: Record<string, unknown> }> = []
    const mutationCalls: Array<{ args: Record<string, unknown> }> = []
    const callbacks: Array<(rows: unknown) => void> = []
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        mutationCalls.push({ args })
        // introduce → returns sessionId; channels.join → returns {channelId}.
        // Dispatch off arg shape to keep the test independent of
        // FunctionReference identity.
        if ('sessionName' in args) return 'session_1'
        if ('channel' in args && 'sessionId' in args && !('text' in args)) {
          return { channelId: 'chan_dev' }
        }
        return undefined
      }),
      onUpdate: vi.fn((_q: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void) => {
        onUpdateCalls.push({ args })
        callbacks.push(cb)
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    await transport.introduce({ sessionName: 'laptop' })
    await transport.joinChannel({ sessionName: 'laptop', channel: 'dev' })

    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})

    // listByChannel must be called with sessionId + channelId.
    expect(onUpdateCalls).toHaveLength(1)
    expect(onUpdateCalls[0]!.args).toMatchObject({
      channelId: 'chan_dev',
      sessionId: 'session_1',
    })

    // Deliver a batch; the highest ts must be acked.
    callbacks[0]!([
      { _id: 'm1', fromSessionId: 'alice', text: 'a', ts: 1_700_000_100_000 },
      { _id: 'm2', fromSessionId: 'alice', text: 'b', ts: 1_700_000_200_000 },
    ])
    // Drain microtasks so the mutation fire-and-forget settles.
    await Promise.resolve()
    await Promise.resolve()

    const ackCalls = mutationCalls.filter(
      (c) =>
        typeof c.args === 'object' &&
        c.args !== null &&
        'sessionId' in c.args &&
        'channelId' in c.args &&
        'ts' in c.args,
    )
    expect(ackCalls).toHaveLength(1)
    expect(ackCalls[0]!.args).toMatchObject({
      sessionId: 'session_1',
      channelId: 'chan_dev',
      ts: 1_700_000_200_000,
    })
  })

  it('seeds the channel cursor from joinChannel latestTs and subscribes past it', async () => {
    // joinChannel returns the channel's join-time ts. The transport must
    // seed it so the reactive listByChannel subscription starts strictly
    // after it — otherwise the channel's pre-existing broadcast history
    // replays as fresh inbound notifications on join.
    const onUpdateCalls: Array<{ args: Record<string, unknown> }> = []
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        if ('sessionName' in args) return 'session_1'
        if ('channel' in args && 'sessionId' in args && !('text' in args)) {
          return { channelId: 'chan_dev', latestTs: 4242 }
        }
        return undefined
      }),
      onUpdate: vi.fn((_q: unknown, args: Record<string, unknown>, _cb: (rows: unknown) => void) => {
        onUpdateCalls.push({ args })
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    await transport.introduce({ sessionName: 'laptop' })
    await transport.joinChannel({ sessionName: 'laptop', channel: 'dev' })
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})

    expect(onUpdateCalls).toHaveLength(1)
    expect(onUpdateCalls[0]!.args).toMatchObject({
      channelId: 'chan_dev',
      sessionId: 'session_1',
      sinceTs: 4242,
    })
  })
})

/**
 * Bootstrap `listAll` vs reactive `listByChannel` (KAI-333 / cc#30 I4):
 * - FNF on bootstrap still disables the whole transport (structural drift).
 * - Transient bootstrap failures skip only `bootstrapChannelSubscribe`, so a
 *   later cached-id subscribe still works.
 */
describe('RemoteTransport.subscribeChannelMessages bootstrap lookup failure routing (KAI-333 finding #3)', () => {
  it('a function-not-found on the listAll bootstrap lookup disables the whole transport, same severity as the reactive subscription', async () => {
    const stub = {
      query: vi.fn(async () => {
        throw new SchemaDriftError('Could not find function channels:listAll on deployment')
      }),
      mutation: vi.fn(async () => undefined),
      onUpdate: vi.fn(() => () => {}),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    // No cached channel id, so this takes the async listAll-lookup path.
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    // Let the fire-and-forget async lookup settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/function not found/i)
  })

  it('transient (non-schema-drift) failures on the listAll bootstrap lookup eventually skip only the bootstrap op', async () => {
    let calls = 0
    const stub = {
      query: vi.fn(async () => {
        calls += 1
        throw new Error(`network blip ${calls}`)
      }),
      mutation: vi.fn(async () => undefined),
      onUpdate: vi.fn(() => () => {}),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    for (let i = 0; i < 3; i++) {
      transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(transport.enabled).toBe(true)
    expect(transport.skippedOps.some((s) => s.op === 'bootstrapChannelSubscribe')).toBe(true)

    // 4th attempt is short-circuited: never reaches the backend lookup.
    const callsBeforeSkip = stub.query.mock.calls.length
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(stub.query.mock.calls.length).toBe(callsBeforeSkip)
    expect(transport.enabled).toBe(true)
  })

  it('bootstrap skip does NOT mute the cached-id subscribe path (cc#30 I4)', async () => {
    let calls = 0
    const onUpdate = vi.fn(() => () => {})
    const stub = {
      query: vi.fn(async () => {
        calls += 1
        throw new Error(`network blip ${calls}`)
      }),
      mutation: vi.fn(async () => undefined),
      onUpdate,
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    for (let i = 0; i < 3; i++) {
      transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
      await Promise.resolve()
      await Promise.resolve()
    }
    // Seed cache as joinChannel would.
    ;(transport as unknown as { channelIdsByName: Map<string, string> }).channelIdsByName.set('dev', 'chan_dev')
    const before = onUpdate.mock.calls.length
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    expect(onUpdate.mock.calls.length).toBe(before + 1)
  })
})

describe('RemoteTransport read-history methods', () => {
  it('readChannelMessages forwards sessionId and maps the page', async () => {
    const { client, queryMock } = makeStubClient(
      async () => ({
        messages: [{ fromSessionId: 'peer', senderSessionName: 'peer', text: 'hi', ts: 1_700_000_000_000 }],
        hasMore: false,
      }),
      async () => 'session_abc',
    )
    const transport = new RemoteTransport({ client })
    await transport.introduce({ sessionName: 'tester', organizationId: 'org_1' })
    // Seed the channel-id cache so the name resolves without a listAll round-trip.
    ;(transport as unknown as { channelIdsByName: Map<string, string> }).channelIdsByName.set('dev', 'chan_1')

    queryMock.mockClear()
    const page = await transport.readChannelMessages({ channel: 'dev', limit: 10 })

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0]![1]).toMatchObject({
      sessionId: 'session_abc',
      channelId: 'chan_1',
      limit: 10,
    })
    expect(page.messages[0]!.text).toBe('hi')
    expect(page.hasMore).toBe(false)
    expect(typeof page.messages[0]!.ts).toBe('number')
    expect(page.oldestTs).toBe(1_700_000_000_000)
  })
})

describe('RemoteTransport.listTopics', () => {
  it('passes through the per-topic messageCount reported by the backend', async () => {
    // The org-scoped KAI backend's `topics.listByChannel` reports a
    // `messageCount` per topic. The transport must forward it so the
    // `list_topics` tool shows a real count instead of 0.
    const { client } = makeStubClient(
      async () => [
        {
          topicId: 'topic_1',
          name: 'plan',
          state: 'active',
          creatorSessionId: 'sess_1',
          createdAt: 1_700_000_000_000,
          messageCount: 3,
        },
      ],
      async () => 'session_abc',
    )
    const transport = new RemoteTransport({ client })
    await transport.introduce({ sessionName: 'tester', organizationId: 'org_1' })

    const topics = await transport.listTopics({ channel: 'dev' })

    expect(topics).toHaveLength(1)
    expect(topics[0]!.messageCount).toBe(3)
  })

  it('leaves messageCount undefined when the backend omits it', async () => {
    // Older backend rows that pre-date the messageCount field must still
    // round-trip through the transport without crashing — joined: false is
    // fine when no count was reported.
    const { client } = makeStubClient(
      async () => [
        {
          topicId: 'topic_1',
          name: 'plan',
          state: 'active',
          creatorSessionId: 'sess_1',
          createdAt: 1_700_000_000_000,
        },
      ],
      async () => 'session_abc',
    )
    const transport = new RemoteTransport({ client })
    await transport.introduce({ sessionName: 'tester', organizationId: 'org_1' })

    const topics = await transport.listTopics({ channel: 'dev' })

    expect(topics).toHaveLength(1)
    expect(topics[0]!.messageCount).toBeUndefined()
  })

  it('passes through the per-session joined flag reported by the backend', async () => {
    // The org-scoped backend reports whether the calling session has joined
    // each topic. The transport must forward it so `list_topics` reflects the
    // real backend membership instead of stale local context.
    const { client } = makeStubClient(
      async () => [
        {
          topicId: 'topic_1',
          name: 'plan',
          state: 'active',
          creatorSessionId: 'sess_1',
          createdAt: 1_700_000_000_000,
          joined: true,
        },
        {
          topicId: 'topic_2',
          name: 'design',
          state: 'active',
          creatorSessionId: 'sess_1',
          createdAt: 1_700_000_000_000,
          joined: false,
        },
      ],
      async () => 'session_abc',
    )
    const transport = new RemoteTransport({ client })
    await transport.introduce({ sessionName: 'tester', organizationId: 'org_1' })

    const topics = await transport.listTopics({ channel: 'dev' })

    expect(topics.map((t) => t.joined)).toEqual([true, false])
  })
})

describe('RemoteTransport.listChannels', () => {
  it('maps the backend presentSessionCount onto sessionCount', async () => {
    // The backend's `listAll` reports a user-level `subscriberCount` and a
    // session-level `presentSessionCount`. The transport must surface the
    // latter as `sessionCount` so `list_channels` can show both.
    const { client } = makeStubClient(
      async () => [{ name: 'dev', subscriberCount: 2, presentSessionCount: 5, messageCount: 7 }],
      async () => 'session_abc',
    )
    const transport = new RemoteTransport({ client })
    await transport.introduce({ sessionName: 'tester', organizationId: 'org_1' })

    const channels = await transport.listChannels({})

    expect(channels).toHaveLength(1)
    expect(channels[0]).toMatchObject({ subscriberCount: 2, sessionCount: 5, messageCount: 7 })
  })
})

describe('RemoteTransport session-scoped query arguments', () => {
  it('forwards sessionId to org-scoped reads once introduce has set it', async () => {
    const { client, queryMock } = makeStubClient(
      async () => [],
      async () => 'session_abc',
    )
    const transport = new RemoteTransport({ client })
    await transport.introduce({ sessionName: 'tester', organizationId: 'org_1' })

    queryMock.mockClear()
    await transport.listChannels({})

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0]![1]).toMatchObject({ sessionId: 'session_abc' })
  })

  it('omits sessionId when no introduce has happened yet', async () => {
    const { client, queryMock } = makeStubClient(async () => [])
    const transport = new RemoteTransport({ client })

    queryMock.mockClear()
    await transport.listChannels({})

    expect(queryMock).toHaveBeenCalledTimes(1)
    expect(queryMock.mock.calls[0]![1]).toEqual({})
  })
})

/**
 * KAI-515: `listSessions` must pass through the backend's stable
 * per-registration `_id` (already returned by `listByChannel`, previously
 * discarded) as `TransportSession.id`, and opportunistically pass through
 * `lastSeen` when the backend reports it. Without an `id`, two dead and
 * live registrations sharing a display name are indistinguishable and get
 * silently merged by the tool layer; see `tools/topics.ts`'s `mergeSessions`.
 */
describe('RemoteTransport.listSessions id/lastSeen passthrough', () => {
  it('passes through the raw row _id as TransportSession.id', async () => {
    const { client } = makeStubClient(async () => [
      { _id: 'session_live', sessionName: 'architect', createdAt: 1_700_000_000_000 },
    ])
    const transport = new RemoteTransport({ client })

    const sessions = await transport.listSessions({})

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe('session_live')
  })

  // Backend field on `sessions.listByChannel` is `lastSeenAt` (see the
  // cccollab Convex handler). The transport must normalise it to
  // `lastSeen` on TransportSession; getting the field name wrong makes
  // the tool-layer staleness filter a permanent no-op in production
  // even though every other piece of KAI-515 is wired up.
  it('normalises the backend row lastSeenAt into TransportSession.lastSeen', async () => {
    const { client } = makeStubClient(async () => [
      {
        _id: 'session_live',
        sessionName: 'architect',
        createdAt: 1_700_000_000_000,
        lastSeenAt: 1_700_000_500_000,
      },
    ])
    const transport = new RemoteTransport({ client })

    const sessions = await transport.listSessions({})

    expect(sessions[0]!.lastSeen).toBe(new Date(1_700_000_500_000).toISOString())
  })

  it('leaves lastSeen undefined when the backend does not report it', async () => {
    const { client } = makeStubClient(async () => [
      { _id: 'session_live', sessionName: 'architect', createdAt: 1_700_000_000_000 },
    ])
    const transport = new RemoteTransport({ client })

    const sessions = await transport.listSessions({})

    expect(sessions[0]!.lastSeen).toBeUndefined()
  })
})

/**
 * KAI-515: `sessions.mutations.updateLastSeen` was declared and wired into
 * `Refs` but never called by the client, so remote sessions never report
 * liveness and dead registrations persist indefinitely server-side. Once
 * `introduce()` has set a `sessionId`, the transport must call
 * `updateLastSeen` periodically until `shutdown()`.
 */
describe('RemoteTransport heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls updateLastSeen periodically once introduced', async () => {
    const mutationCalls: Array<{ fn: unknown; args: unknown }> = []
    const { client } = makeStubClient(
      async () => [],
      async (fnRef: unknown, args: unknown) => {
        mutationCalls.push({ fn: fnRef, args })
        return 'session_abc'
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'tester' })

    mutationCalls.length = 0
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(mutationCalls).toHaveLength(1)
    expect(mutationCalls[0]!.args).toMatchObject({ sessionId: 'session_abc' })
  })

  it('stops sending heartbeats after shutdown', async () => {
    const mutationCalls: unknown[] = []
    const { client } = makeStubClient(
      async () => [],
      async (fnRef: unknown, args: unknown) => {
        mutationCalls.push(args)
        return 'session_abc'
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'tester' })
    await transport.shutdown()

    mutationCalls.length = 0
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)

    expect(mutationCalls).toHaveLength(0)
  })

  it('does not trip the degradation circuit when a heartbeat call fails transiently', async () => {
    let mutationCount = 0
    const { client } = makeStubClient(
      async () => [],
      async () => {
        mutationCount += 1
        if (mutationCount === 1) return 'session_abc'
        throw new Error('transient heartbeat failure')
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'tester' })

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 4)

    expect(transport.enabled).toBe(true)
  })

  // KAI-515 review follow-up: a heartbeat is the ONLY remote call a
  // long-lived, mostly-idle session makes. If it fails because the
  // deployment renamed/removed the mutation, or the session's auth
  // expired, that's a real transport-health signal — swallowing it
  // unconditionally would leave the transport reporting `enabled: true`
  // forever while liveness silently never gets reported.
  it('trips the degradation circuit when a heartbeat call hits a function-not-found error', async () => {
    let mutationCount = 0
    const { client } = makeStubClient(
      async () => [],
      async () => {
        mutationCount += 1
        if (mutationCount === 1) return 'session_abc'
        const err = new Error('Could not find function cccollab/sessions:updateLastSeen')
        err.name = 'FunctionNotFoundError'
        throw err
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'tester' })

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/function not found/i)
  })

  it('trips the degradation circuit when a heartbeat call hits an auth error', async () => {
    let mutationCount = 0
    const { client } = makeStubClient(
      async () => [],
      async () => {
        mutationCount += 1
        if (mutationCount === 1) return 'session_abc'
        const err = new Error('Sign-in required.') as Error & { data: { code: string } }
        err.data = { code: 'UNAUTHENTICATED' }
        throw err
      },
    )
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'tester' })

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)

    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/authentication failed/i)
  })
})
