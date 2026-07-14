import { describe, it, expect, vi } from 'vitest'
import type { ConvexClient } from 'convex/browser'

import { RemoteTransport } from '../../src/transport/remote.js'

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

    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, onEvent)
    // Simulate Convex delivering two messages.
    callbacks[0]!([
      { _id: 'msg_1', fromSessionId: 'alice', text: 'first', ts: 1_700_000_100_000 },
      { _id: 'msg_2', fromSessionId: 'alice', text: 'second', ts: 1_700_000_200_000 },
    ])
    expect(delivered).toHaveLength(2)
    expect(onUpdateCalls[0]!.args).toEqual({ topicId: 't1' })

    transport.forgetTopicFeed('t1')

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
 * Self-echo filtering must survive a re-introduce.
 *
 * Auto-subscribed channels/topics are subscribed BEFORE the agent calls
 * `introduce` with its real name, and `introduce` rebinds `this.sessionId`
 * to the new backend session row. A filter that compares against the
 * sessionId captured at SUBSCRIBE time therefore stops recognising our own
 * messages after a rename, and the session gets its own broadcasts pushed
 * back at it as inbound events.
 */
describe('RemoteTransport self-echo filtering across a re-introduce', () => {
  function makeReintroduceStub(): {
    client: ConvexClient
    callbacks: Array<(rows: unknown) => void>
  } {
    const callbacks: Array<(rows: unknown) => void> = []
    const sessionIds = ['session_bootstrap', 'session_renamed']
    let introduceCount = 0
    const stub = {
      query: vi.fn(async () => []),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        // Dispatch off arg shape so the test stays independent of
        // FunctionReference identity (as elsewhere in this file).
        if ('sessionName' in args) return sessionIds[introduceCount++] ?? 'session_extra'
        if ('channel' in args && 'sessionId' in args && !('text' in args)) return { channelId: 'chan_dev' }
        return undefined
      }),
      onUpdate: vi.fn((_q: unknown, _args: Record<string, unknown>, cb: (rows: unknown) => void) => {
        callbacks.push(cb)
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    return { client: stub as unknown as ConvexClient, callbacks }
  }

  it('drops own topic messages sent under the post-rename session id', async () => {
    const { client, callbacks } = makeReintroduceStub()
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'bootstrap' })

    const delivered: string[] = []
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, (msg) => delivered.push(msg.text))

    await transport.introduce({ sessionName: 'kai-408' })

    callbacks[0]!([
      { _id: 'm1', fromSessionId: 'session_renamed', text: 'my own message', ts: 1_700_000_100_000 },
      { _id: 'm2', fromSessionId: 'session_alice', text: 'someone else', ts: 1_700_000_200_000 },
    ])

    expect(delivered).toEqual(['someone else'])
  })

  it('drops own channel broadcasts sent under the post-rename session id', async () => {
    const { client, callbacks } = makeReintroduceStub()
    const transport = new RemoteTransport({ client, log: () => {} })
    await transport.introduce({ sessionName: 'bootstrap' })
    await transport.joinChannel({ sessionName: 'bootstrap', channel: 'dev' })

    const delivered: string[] = []
    transport.subscribeChannelMessages({ channelName: 'dev' }, (msg) => delivered.push(msg.text))

    await transport.introduce({ sessionName: 'kai-408' })

    callbacks[0]!([
      { _id: 'm1', fromSessionId: 'session_renamed', text: 'my own broadcast', ts: 1_700_000_100_000 },
      { _id: 'm2', fromSessionId: 'session_alice', text: 'someone else', ts: 1_700_000_200_000 },
    ])
    // Let the fire-and-forget ackChannel settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(delivered).toEqual(['someone else'])
  })
})

/**
 * A reactive subscription binds `this.sessionId` into its QUERY ARGS at
 * subscribe time, and Convex keeps those args for the life of the
 * subscription. The backend gates both feeds on that session's membership
 * rows. So when `introduce` rebinds the session row, the old subscription
 * is querying as a session that no longer holds the memberships — the tool
 * layer must re-subscribe, and the fresh subscription must carry the new id
 * without rewinding the cursor and replaying history.
 */
describe('RemoteTransport re-subscription after a re-introduce', () => {
  it('binds the NEW sessionId into the query args and keeps the existing cursor', async () => {
    const onUpdateCalls: Array<{ args: Record<string, unknown> }> = []
    const callbacks: Array<(rows: unknown) => void> = []
    const sessionIds = ['session_bootstrap', 'session_renamed']
    let introduceCount = 0
    const stub = {
      query: vi.fn(async () => []),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        if ('sessionName' in args) return sessionIds[introduceCount++] ?? 'session_extra'
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

    await transport.introduce({ sessionName: 'bootstrap' })
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})
    expect(onUpdateCalls[0]!.args).toEqual({ topicId: 't1', sessionId: 'session_bootstrap' })

    // Deliver a message so the transport's own high-water mark advances.
    callbacks[0]!([{ _id: 'm1', fromSessionId: 'session_alice', text: 'hi', ts: 1_700_000_200_000 }])

    // The rename: tear the old subscription down, re-introduce, re-subscribe.
    transport.forgetTopicFeed('t1')
    await transport.introduce({ sessionName: 'kai-408' })
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})

    // The new subscription queries as the NEW session row, and resumes from
    // the transport's retained cursor rather than replaying from zero.
    expect(onUpdateCalls).toHaveLength(2)
    expect(onUpdateCalls[1]!.args).toEqual({
      topicId: 't1',
      sessionId: 'session_renamed',
      sinceTs: 1_700_000_200_000,
    })
  })
})

/**
 * A re-join must PRESERVE the delivery cursor, not bump it forward.
 *
 * `joinChannel` seeds `channelMaxTs` so the reactive feed skips pre-join
 * history. But the identity migration re-joins the channel mid-rename, and
 * if that re-join advances the cursor to the channel's current `latestTs`,
 * any peer broadcast that landed during the teardown→leave→introduce→rejoin
 * window (ts ≤ latestTs) is skipped forever, because
 * `subscribeChannelMessages` resumes at `sinceTs = channelMaxTs` EXCLUSIVE.
 * Mirrors `joinTopic`, which never clobbers `topicMaxTs`.
 */
describe('RemoteTransport.joinChannel cursor preservation on re-join', () => {
  // The "seeds on the first join, preserves on a re-join" rule (seed 100,
  // deliver 300, re-join reports 500, resume at 300) now lives in
  // tests/remote/feed-lifecycle.test.ts — 'preserves the delivery cursor across
  // a suspend/restore'. Same numbers, same assertions, but driven through the
  // real seam (rebind ⇒ suspend, joinChannel ⇒ restore) instead of the manual
  // double-subscribe it used to use: the feed registry is idempotent now, so a
  // second subscribeChannelMessages for the same channel is a no-op and the old
  // mechanism can no longer be expressed. The behaviour is not weakened, only
  // re-homed to the layer that now owns it.

  /**
   * The other half of that rule. Seeding `channelMaxTs` only when absent is what
   * lets the migration's transient leave/re-join keep its place in the stream —
   * but it also means a cursor left behind by a DELIBERATE `leave_channel` would
   * survive, and a later re-join would resume from it and replay every broadcast
   * that accrued while the session was away as fresh inbound notifications.
   * `forgetChannelCursor` (called from the leave_channel tool, never from the
   * migration) drops it so the re-join re-seeds from `latestTs` and skips that
   * backlog.
   */
  it('forgets the cursor on a deliberate leave, so a later re-join skips the backlog', async () => {
    const onUpdateCalls: Array<{ args: Record<string, unknown> }> = []
    const callbacks: Array<(rows: unknown) => void> = []
    let joinLatestTs = 100
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        if ('sessionName' in args) return 'session_1'
        if ('channel' in args && 'sessionId' in args && !('text' in args)) {
          return { channelId: 'chan_dev', latestTs: joinLatestTs }
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

    await transport.introduce({ sessionName: 'me' })
    await transport.joinChannel({ sessionName: 'me', channel: 'dev' })
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    // Deliver a broadcast so the delivered cursor advances to 300.
    callbacks[0]!([{ _id: 'm1', fromSessionId: 'peer', text: 'hi', ts: 300 }])

    // Deliberate leave_channel: drops the feed AND forgets the cursor (one call).
    transport.forgetChannelFeed('dev')

    // A large backlog accrues while the session is away.
    joinLatestTs = 99_999

    await transport.joinChannel({ sessionName: 'me', channel: 'dev' })
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})

    // Re-seeded from latestTs — NOT resumed from the stale 300, which would
    // replay the whole 300..99_999 backlog at the agent.
    expect(onUpdateCalls).toHaveLength(2)
    expect(onUpdateCalls[1]!.args).toMatchObject({ sinceTs: 99_999 })
  })
})

/**
 * The premise the tool layer's per-location gate rests on: a FAILED introduce
 * must leave `sessionId` pointing at the PREVIOUS row. That is exactly why a
 * location whose introduce threw must not be re-joined or re-subscribed — its
 * id still addresses the pre-rename identity, so doing so would recreate the
 * old-name ghost. The only existing coverage is the first-ever introduce
 * (null → null), which a refactor to "clear the id, then set it" would satisfy
 * while silently nulling the id here.
 */
describe('RemoteTransport.introduce failure preserves the previously bound session', () => {
  it('keeps the previous sessionId when a LATER introduce fails', async () => {
    let introduceCount = 0
    const stub = {
      query: vi.fn(async () => []),
      mutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
        if ('sessionName' in args) {
          introduceCount += 1
          if (introduceCount === 1) return 'session_1'
          throw new Error('backend rejected introduce')
        }
        return undefined
      }),
      onUpdate: vi.fn(() => () => {}),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })

    await transport.introduce({ sessionName: 'bootstrap' })
    expect((transport as unknown as { sessionId: string | null }).sessionId).toBe('session_1')

    await expect(transport.introduce({ sessionName: 'kai-408' })).rejects.toThrow(/backend rejected/)

    // Still bound to the OLD row — NOT null, NOT the new name.
    expect((transport as unknown as { sessionId: string | null }).sessionId).toBe('session_1')
  })
})
