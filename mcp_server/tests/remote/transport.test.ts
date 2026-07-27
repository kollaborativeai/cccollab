import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ConvexClient } from 'convex/browser'

import { RemoteTransport, HEARTBEAT_INTERVAL_MS } from '../../src/transport/remote.js'

/**
 * Self-disable transition test.
 *
 * The `RemoteTransport` graceful-degradation policy trips `enabled = false`
 * on the first `FunctionNotFoundError` (schema drift) or after three
 * generic failures within a 60s window. Subsequent calls short-circuit and
 * return empty results without hitting the ConvexClient again, while local
 * tools keep working.
 *
 * We construct a minimal ConvexClient stub whose `query` method rejects
 * with the relevant error the first time it's called. That's enough to
 * exercise the transition inside `listChannels()`.
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
  it('flips enabled=false on the first schema-drift error and subsequent calls short-circuit', async () => {
    const { client, queryMock } = makeStubClient(async () => {
      throw new SchemaDriftError('Could not find function channels:listAll on deployment')
    })
    const log: string[] = []
    const transport = new RemoteTransport({ client, log: (m) => log.push(m) })

    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()

    // First call trips the switch - listChannels returns an empty array
    // rather than propagating the error, because the transport's
    // `registerFailure` swallows it.
    const first = await transport.listChannels({})
    expect(first).toEqual([])
    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/function not found/i)

    // Second call short-circuits - it never hits the stub's `query`.
    const callsBeforeSecond = queryMock.mock.calls.length
    const second = await transport.listChannels({})
    expect(second).toEqual([])
    expect(queryMock.mock.calls.length).toBe(callsBeforeSecond)
  })

  it('trips after three generic failures within the rolling window', async () => {
    let counter = 0
    const { client } = makeStubClient(async () => {
      counter += 1
      throw new Error(`network blip ${counter}`)
    })
    const transport = new RemoteTransport({ client, log: () => {} })

    await transport.listChannels({})
    expect(transport.enabled).toBe(true)
    await transport.listChannels({})
    expect(transport.enabled).toBe(true)
    await transport.listChannels({})
    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/3 failures/)
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

  it('rethrow does not bypass the failure counter (still counts toward degradation)', async () => {
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
    // Three failures in the window disables the transport.
    for (let i = 0; i < 3; i++) {
      await expect(transport.introduce({ sessionName: 'laptop' })).rejects.toThrow()
    }
    expect(transport.enabled).toBe(false)
  })

  it('introduce on a disabled transport throws rather than silently no-op', async () => {
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => {
        throw new Error('perm error')
      }),
      onUpdate: vi.fn(),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    // Trip the circuit breaker.
    for (let i = 0; i < 3; i++) {
      await transport.introduce({ sessionName: 'x' }).catch(() => {})
    }
    expect(transport.enabled).toBe(false)
    // A subsequent introduce must not silently succeed.
    await expect(transport.introduce({ sessionName: 'x' })).rejects.toThrow(/disabled/)
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
 * KAI-438: a dead remote subscription must not leave the transport
 * reporting healthy while the session silently receives nothing.
 *
 * Two facts, both verified live against production on 2026-07-15:
 *
 *  1. A subscription bound to a missing/renamed function surfaces a plain
 *     `Error` whose message the deployment masks to `[CONVEX Q(...)] Server
 *     Error`. It is NOT named `FunctionNotFoundError`, so the old strict
 *     branch in `registerSubscriptionFailure` never fired in production.
 *  2. A dead subscription's `onError` fires exactly ONCE and the
 *     subscription never recovers, so the 3-in-60s rolling window never
 *     tripped either. `enabled` stayed `true` forever, silently blind.
 *
 * The fix is matcher-free by design. Production masks the message, so any
 * string matcher is a guess calibrated against a shape production never
 * emits (the KAI-434 family — the reason the old tests passed while the
 * code was broken). Since `onError` is terminal for that subscription
 * whatever the cause, we do not classify it: we replace the subscription
 * and discriminate BY EXPERIMENT. A transient fault lets the replacement
 * stream fine; structural drift makes every replacement fail too, and the
 * exhausted retries surface loudly.
 */

/** The real production error shape, captured live 2026-07-15: a plain
 *  `Error`, message masked by the deployment. Deliberately NOT named
 *  `FunctionNotFoundError` — that shape exists only in test files. */
const maskedProductionError = (): Error => new Error('[CONVEX Q(cccollab/messages:listByTopic)] Server Error')

interface SubStub {
  stub: Record<string, unknown>
  errCbs: Array<(err: unknown) => void>
  dataCbs: Array<(rows: unknown) => void>
  argsSeen: Array<Record<string, unknown>>
  unsubs: Array<ReturnType<typeof vi.fn>>
}

function makeSubStub(): SubStub {
  const errCbs: Array<(err: unknown) => void> = []
  const dataCbs: Array<(rows: unknown) => void> = []
  const argsSeen: Array<Record<string, unknown>> = []
  const unsubs: Array<ReturnType<typeof vi.fn>> = []
  const stub = {
    query: vi.fn(async () => undefined),
    mutation: vi.fn(async () => undefined),
    onUpdate: vi.fn(
      (_q: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void, errCb: (err: unknown) => void) => {
        argsSeen.push(args)
        dataCbs.push(cb)
        errCbs.push(errCb)
        const u = vi.fn()
        unsubs.push(u)
        return u
      },
    ),
    setAuth: vi.fn(),
  }
  return { stub, errCbs, dataCbs, argsSeen, unsubs }
}

describe('RemoteTransport subscription resilience (KAI-438)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-subscribes after a masked production error instead of going silently dead', async () => {
    vi.useFakeTimers()
    const { stub, errCbs } = makeSubStub()
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})
    expect(stub.onUpdate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)

    // The exact production shape that `isFunctionNotFoundError` misses.
    errCbs[0]!(maskedProductionError())
    await vi.advanceTimersByTimeAsync(2_000)

    // Before the fix this stayed at 1 call forever: enabled, and deaf.
    expect((stub.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('a transient fault recovers: the replacement subscription delivers and the transport stays enabled', async () => {
    vi.useFakeTimers()
    const { stub, errCbs, dataCbs } = makeSubStub()
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    const delivered: string[] = []
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, (m) => delivered.push(m.text))

    errCbs[0]!(new Error('[CONVEX Q(cccollab/messages:listByTopic)] Server Error'))
    await vi.advanceTimersByTimeAsync(2_000)

    // The replacement streams fine -> the fault was transient.
    dataCbs[1]!([{ _id: 'm1', fromSessionId: 'alice', text: 'after recovery', ts: 1_700_000_100_000 }])

    expect(delivered).toEqual(['after recovery'])
    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()
  })

  it('four intermittent blips, each followed by a healthy delivery, never disable the transport', async () => {
    // AC2's actual mechanism: `onHealthy` resetting `failures` to 0.
    // `failures` is a LIFETIME counter with no time window (unlike
    // `recentFailures`/DEGRADATION_WINDOW_MS), so without the reset four
    // blips at *any* spacing — four separate days — accumulate to an
    // exhausted schedule and permanently disable the transport with no
    // auto-recovery. The neighbouring "a transient fault recovers" test
    // cannot catch that: it fires exactly one error, and one error never
    // disables anything whether the reset exists or not.
    vi.useFakeTimers()
    const { stub, errCbs, dataCbs } = makeSubStub()
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    const delivered: string[] = []
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, (m) => delivered.push(m.text))

    // Three full error → recover cycles. Each recovery must clear the debt
    // left by the error before it. 20s drains even the longest backoff in
    // RESUBSCRIBE_DELAYS_MS, so the replacement opens either way.
    for (let cycle = 0; cycle < 3; cycle++) {
      errCbs[cycle]!(maskedProductionError())
      await vi.advanceTimersByTimeAsync(20_000)
      dataCbs[cycle + 1]!([
        { _id: `m${cycle}`, fromSessionId: 'alice', text: `recovered ${cycle}`, ts: 1_700_000_100_000 + cycle },
      ])
    }
    expect(delivered).toEqual(['recovered 0', 'recovered 1', 'recovered 2'])

    // The fourth blip. With the reset it is the counter's *first* failure;
    // without it, it is the fourth and exhausts the schedule.
    errCbs[3]!(maskedProductionError())
    await vi.advanceTimersByTimeAsync(20_000)

    expect(transport.enabled).toBe(true)
    expect(transport.degradation).toBeNull()
  })

  it('tears down the dead subscription handle before replacing it (no duplicate streams)', async () => {
    vi.useFakeTimers()
    const { stub, errCbs, unsubs } = makeSubStub()
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})
    errCbs[0]!(maskedProductionError())
    await vi.advanceTimersByTimeAsync(2_000)

    expect(unsubs[0]!).toHaveBeenCalled()
  })

  it('resumes from the watermark on an automatic re-subscribe (no history replay)', async () => {
    vi.useFakeTimers()
    const { stub, errCbs, dataCbs, argsSeen } = makeSubStub()
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})
    dataCbs[0]!([{ _id: 'm1', fromSessionId: 'alice', text: 'seen', ts: 1_700_000_200_000 }])
    expect(argsSeen[0]).toEqual({ topicId: 't1' })

    errCbs[0]!(maskedProductionError())
    await vi.advanceTimersByTimeAsync(2_000)

    expect(argsSeen[1]).toEqual({ topicId: 't1', sinceTs: 1_700_000_200_000 })
  })

  it('makes structural drift visible: exhausted re-subscribes disable the transport with a reason naming schema drift', async () => {
    vi.useFakeTimers()
    const { stub, errCbs } = makeSubStub()
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})

    // Every replacement errors too — that is what structural drift looks
    // like from the client, without ever parsing the message.
    for (let i = 0; i < 8; i++) {
      const cb = errCbs[errCbs.length - 1]
      if (cb === undefined) break
      cb(maskedProductionError())
      await vi.advanceTimersByTimeAsync(30_000)
    }

    // The acceptance criterion: NOT enabled-and-silently-dead.
    expect(transport.enabled).toBe(false)
    expect(transport.degradation).toMatch(/schema drift/i)
  })

  /** Resolve 'dev' through the async `channels.queries.listAll` lookup —
   *  the path that re-enters `register` from a promise, which the topic
   *  path has no equivalent of. */
  function makeChannelSubStub(): SubStub {
    const sub = makeSubStub()
    sub.stub.query = vi.fn(async () => [{ channelId: 'chan_dev', name: 'dev' }])
    return sub
  }

  it('re-subscribes a dead CHANNEL subscription instead of silently losing every later broadcast', async () => {
    // The channel path is the higher-traffic one and carries machinery the
    // topic path does not: `register` re-entered after the async listAll,
    // the `innerUnsubscribe` reassignment, a cursor keyed by channelId and
    // the fire-and-forget ackChannel. Reverting it to pre-PR silent death
    // loses 'after recovery' with the whole suite still green.
    vi.useFakeTimers()
    const { stub, errCbs, dataCbs, unsubs } = makeChannelSubStub()
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    const delivered: string[] = []
    transport.subscribeChannelMessages({ channelName: 'dev' }, (m) => delivered.push(m.text))
    // Let the async channel-id lookup land and `register` run.
    await vi.advanceTimersByTimeAsync(0)
    expect(stub.onUpdate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)

    dataCbs[0]!([{ _id: 'm1', fromSessionId: 'alice', text: 'before', ts: 1_700_000_500_000 }])
    errCbs[0]!(maskedProductionError())
    await vi.advanceTimersByTimeAsync(2_000)

    // A replacement must exist, and the dead handle must be torn down first.
    expect((stub.onUpdate as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(unsubs[0]!).toHaveBeenCalled()

    dataCbs[1]!([{ _id: 'm2', fromSessionId: 'alice', text: 'after recovery', ts: 1_700_000_600_000 }])

    expect(delivered).toEqual(['before', 'after recovery'])
    expect(transport.enabled).toBe(true)
  })

  it('resumes a CHANNEL re-subscribe from the channelId-keyed watermark', async () => {
    // The channel cursor lives in `channelMaxTs`, keyed by channelId rather
    // than topicId, and is read inside the attempt so a replacement resumes
    // where its predecessor stopped instead of replaying the channel's
    // broadcast history.
    vi.useFakeTimers()
    const { stub, errCbs, dataCbs, argsSeen } = makeChannelSubStub()
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    await vi.advanceTimersByTimeAsync(0)

    dataCbs[0]!([{ _id: 'm1', fromSessionId: 'alice', text: 'seen', ts: 1_700_000_500_000 }])
    expect(argsSeen[0]).toEqual({ channelId: 'chan_dev' })

    errCbs[0]!(maskedProductionError())
    await vi.advanceTimersByTimeAsync(2_000)

    expect(argsSeen[1]).toEqual({ channelId: 'chan_dev', sinceTs: 1_700_000_500_000 })
  })

  it('does not describe a dead subscription as "(transient)"', async () => {
    vi.useFakeTimers()
    const { stub, errCbs } = makeSubStub()
    const log: string[] = []
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: (m) => log.push(m) })

    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})
    errCbs[0]!(maskedProductionError())
    await vi.advanceTimersByTimeAsync(2_000)

    // The subscription is dead, not transient — the old wording is a
    // large part of why this read as harmless.
    expect(log.join('\n')).not.toMatch(/\(transient\)/)
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
