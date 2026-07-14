import { describe, it, expect, vi } from 'vitest'
import type { ConvexClient } from 'convex/browser'
import { getFunctionName } from 'convex/server'

import { RemoteTransport } from '../../src/transport/remote.js'
import type { ParsedMessage } from '../../src/types.js'

/**
 * RemoteTransport owns the lifecycle of its own live feeds (KAI-418).
 *
 * KAI-408 produced three separate bugs — feeds left bound to a stale
 * sessionId, a degraded rename that could never self-heal, and a channel-key
 * mismatch that registered a duplicate feed on every re-introduce. All three
 * are one seam: the TOOL layer remembering to keep subscription bookkeeping in
 * sync with transport state it does not own. These tests pin the invariant at
 * the transport, with NO tool layer involved at all, so the ownership cannot
 * drift back.
 */

interface Feed {
  id: number
  query: string
  args: Record<string, unknown>
  cb: (rows: unknown) => void
  alive: boolean
}

interface Harness {
  client: ConvexClient
  /** Ordered log of everything that crossed the wire, so a test can assert that
   *  a feed was torn down BEFORE the mutation that invalidates it. */
  events: string[]
  feeds: Feed[]
  live: (query: string) => Feed[]
  failIntroduce: (v: boolean) => void
}

/** `cccollab/channels:join` -> `channels:join` */
const shortName = (ref: unknown): string => getFunctionName(ref as never).split('/')[1] ?? ''

function makeHarness(opts?: {
  sessionIds?: string[]
  joinLatestTs?: number[]
  /** How the async channel-id lookup behaves. A channel feed subscribed before
   *  any `joinChannel` has cached its id must resolve the id via
   *  `channels:listAll` — which can reject, or come back with no matching row.
   *  Either way `register()` never runs and the feed is NOT live. */
  listAll?: 'ok' | 'reject' | 'nomatch'
  /** Make `client.onUpdate` throw for this query, modelling a client that
   *  refuses to register the subscription (e.g. closed / rejected args). The
   *  feed must then NOT be considered live. */
  onUpdateThrowsFor?: string
}): Harness {
  const events: string[] = []
  const feeds: Feed[] = []
  const sessionIds = opts?.sessionIds ?? ['session_1']
  const joinLatestTs = opts?.joinLatestTs ?? []
  const listAll = opts?.listAll ?? 'ok'
  const onUpdateThrowsFor = opts?.onUpdateThrowsFor
  let nextId = 0
  let introduceCount = 0
  let channelJoinCount = 0
  let failing = false

  const client = {
    mutation: vi.fn(async (ref: unknown, _args: Record<string, unknown>) => {
      const name = shortName(ref)
      events.push(`mutation:${name}`)
      if (name === 'sessions:introduce') {
        if (failing) throw new Error('introduce blew up')
        const id = sessionIds[Math.min(introduceCount, sessionIds.length - 1)]!
        introduceCount += 1
        return id
      }
      if (name === 'channels:join') {
        const ts = joinLatestTs[Math.min(channelJoinCount, joinLatestTs.length - 1)]
        channelJoinCount += 1
        return { channelId: 'chan_dev', ...(ts !== undefined ? { latestTs: ts } : {}) }
      }
      if (name === 'topics:join') return { topicId: 't1', channelId: 'chan_dev', name: 'T' }
      return undefined
    }),
    query: vi.fn(async (ref: unknown) => {
      const name = shortName(ref)
      if (name === 'channels:listAll') {
        events.push('query:channels:listAll')
        if (listAll === 'reject') throw new Error('listAll blew up')
        if (listAll === 'nomatch') return [{ channelId: 'chan_other', name: 'somewhere-else' }]
        return [
          { channelId: 'chan_dev', name: 'dev' },
          { channelId: 'chan_ops', name: 'ops' },
        ]
      }
      return []
    }),
    onUpdate: vi.fn((ref: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void) => {
      const name = shortName(ref)
      if (onUpdateThrowsFor === name) throw new Error(`onUpdate refused for ${name}`)
      const id = (nextId += 1)
      const feed: Feed = { id, query: name, args, cb, alive: true }
      feeds.push(feed)
      events.push(`onUpdate:${name}#${id}`)
      return () => {
        feed.alive = false
        events.push(`unsub:${name}#${id}`)
      }
    }),
    setAuth: vi.fn(),
    close: vi.fn(async () => {}),
  }

  return {
    client: client as unknown as ConvexClient,
    events,
    feeds,
    live: (query: string) => feeds.filter((f) => f.alive && f.query === query),
    failIntroduce: (v: boolean) => {
      failing = v
    },
  }
}

const TOPIC_Q = 'messages:listByTopic'
const CHANNEL_Q = 'messages:listByChannel'

function makeTransport(h: Harness): RemoteTransport {
  return new RemoteTransport({ client: h.client, source: 'remote', log: () => {} })
}

/** Introduce, join a channel + topic, and subscribe both feeds. */
async function bootWithBothFeeds(
  t: RemoteTransport,
  opts?: { organizationId?: string },
): Promise<{ topicMsgs: string[]; channelMsgs: string[] }> {
  const topicMsgs: string[] = []
  const channelMsgs: string[] = []
  await t.introduce({ sessionName: 'a', organizationId: opts?.organizationId })
  await t.joinChannel({ sessionName: 'a', channel: 'dev' })
  await t.joinTopic({ sessionName: 'a', topicId: 't1' })
  t.subscribeChannelMessages({ channelName: 'dev' }, (m: ParsedMessage) => channelMsgs.push(m.text))
  t.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, (m: ParsedMessage) => topicMsgs.push(m.text))
  return { topicMsgs, channelMsgs }
}

describe('RemoteTransport owns its feed lifecycle', () => {
  it('re-registers its feeds under the NEW sessionId on a rebind, keeping the original callbacks', async () => {
    // THE headline invariant: a rebind cannot silently skip re-registration.
    // No tool layer anywhere in this test — the transport does it itself.
    const h = makeHarness({ sessionIds: ['session_a', 'session_b'] })
    const t = makeTransport(h)
    const { topicMsgs, channelMsgs } = await bootWithBothFeeds(t)

    expect(h.live(TOPIC_Q)[0]!.args).toMatchObject({ sessionId: 'session_a' })
    expect(h.live(CHANNEL_Q)[0]!.args).toMatchObject({ sessionId: 'session_a' })

    // The identity rebinds, and the memberships come back.
    await t.introduce({ sessionName: 'b' })
    await t.joinChannel({ sessionName: 'b', channel: 'dev' })
    await t.joinTopic({ sessionName: 'b', topicId: 't1' })

    // Exactly one live feed each, now bound to the NEW session row.
    expect(h.live(TOPIC_Q)).toHaveLength(1)
    expect(h.live(CHANNEL_Q)).toHaveLength(1)
    expect(h.live(TOPIC_Q)[0]!.args).toMatchObject({ sessionId: 'session_b', topicId: 't1' })
    expect(h.live(CHANNEL_Q)[0]!.args).toMatchObject({ sessionId: 'session_b', channelId: 'chan_dev' })

    // ...and the ORIGINAL onEvent callbacks are still the ones invoked.
    h.live(TOPIC_Q)[0]!.cb([{ _id: 'm1', fromSessionId: 'peer', text: 'topic-hi', ts: 10 }])
    h.live(CHANNEL_Q)[0]!.cb([{ _id: 'm2', fromSessionId: 'peer', text: 'chan-hi', ts: 11 }])
    expect(topicMsgs).toEqual(['topic-hi'])
    expect(channelMsgs).toEqual(['chan-hi'])
  })

  it('suspends a topic feed BEFORE the leaveTopic mutation that invalidates it', async () => {
    // A live onUpdate whose membership row disappears throws ConvexError, and
    // three of those disable the whole transport. Order is the safety property.
    const h = makeHarness()
    const t = makeTransport(h)
    await bootWithBothFeeds(t)
    h.events.length = 0

    await t.leaveTopic({ sessionName: 'a', topicId: 't1' })

    const unsubAt = h.events.findIndex((e) => e.startsWith(`unsub:${TOPIC_Q}`))
    const mutationAt = h.events.indexOf('mutation:topics:leave')
    expect(unsubAt).toBeGreaterThanOrEqual(0)
    expect(mutationAt).toBeGreaterThanOrEqual(0)
    expect(unsubAt).toBeLessThan(mutationAt)
    expect(h.live(TOPIC_Q)).toHaveLength(0)
  })

  it('suspends a channel feed AND the topic feeds inside it, before the leaveChannel mutation', async () => {
    // The backend's listByTopic asserts CHANNEL presence, so a topic feed in a
    // channel we are leaving would start erroring the moment membership goes.
    const h = makeHarness()
    const t = makeTransport(h)
    await bootWithBothFeeds(t)
    // A second topic, in a DIFFERENT channel, which must survive.
    t.subscribeTopicMessages({ topicId: 't2', channelName: 'ops' }, () => {})
    h.events.length = 0

    await t.leaveChannel({ sessionName: 'a', channel: 'dev' })

    const mutationAt = h.events.indexOf('mutation:channels:leave')
    const unsubs = h.events.filter((e) => e.startsWith('unsub:'))
    expect(unsubs).toHaveLength(2) // the dev channel feed + the t1 topic feed
    for (const u of unsubs) expect(h.events.indexOf(u)).toBeLessThan(mutationAt)

    // t1 (in dev) is suspended; t2 (in ops) is untouched.
    expect(h.live(TOPIC_Q).map((f) => f.args.topicId)).toEqual(['t2'])
    expect(h.live(CHANNEL_Q)).toHaveLength(0)
  })

  it('churns nothing on an idempotent re-introduce (same session row)', async () => {
    const h = makeHarness({ sessionIds: ['session_a'] }) // introduce always returns the same id
    const t = makeTransport(h)
    await bootWithBothFeeds(t)
    h.events.length = 0

    await t.introduce({ sessionName: 'a' })

    expect(h.events.filter((e) => e.startsWith('unsub:') || e.startsWith('onUpdate:'))).toEqual([])
    expect(h.live(TOPIC_Q)).toHaveLength(1)
    expect(h.live(CHANNEL_Q)).toHaveLength(1)
  })

  it('preserves the delivery cursor across a suspend/restore (no replay, no loss)', async () => {
    // KAI-408's numbers: seed 100, deliver 300, the re-join reports 500 —
    // the restored feed must resume at 300. A suspend/restore is NOT a
    // deliberate leave and must not forget the cursor.
    const h = makeHarness({ sessionIds: ['session_a', 'session_b'], joinLatestTs: [100, 500] })
    const t = makeTransport(h)
    await t.introduce({ sessionName: 'a' })
    await t.joinChannel({ sessionName: 'a', channel: 'dev' })
    t.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    expect(h.live(CHANNEL_Q)[0]!.args).toMatchObject({ sinceTs: 100 })

    h.live(CHANNEL_Q)[0]!.cb([{ _id: 'm1', fromSessionId: 'peer', text: 'hi', ts: 300 }])

    await t.introduce({ sessionName: 'b' }) // rebind ⇒ suspend
    await t.joinChannel({ sessionName: 'b', channel: 'dev' }) // ⇒ restore

    expect(h.live(CHANNEL_Q)).toHaveLength(1)
    expect(h.live(CHANNEL_Q)[0]!.args).toMatchObject({ sessionId: 'session_b', sinceTs: 300 })
  })

  it('self-heals: feeds suspended by a failed migration are restored by a later successful join', async () => {
    // The KAI-408 "degraded rename can never self-heal" bug, now impossible:
    // no tool-layer bookkeeping is involved in the recovery at all.
    const h = makeHarness({ sessionIds: ['session_a', 'session_b'] })
    const t = makeTransport(h)
    const { topicMsgs, channelMsgs } = await bootWithBothFeeds(t)

    // A migration tears the old identity down, then its introduce fails.
    await t.leaveTopic({ sessionName: 'a', topicId: 't1' })
    await t.leaveChannel({ sessionName: 'a', channel: 'dev' })
    h.failIntroduce(true)
    await expect(t.introduce({ sessionName: 'b' })).rejects.toThrow()

    // Deaf, and honest about it.
    expect(t.suspendedFeeds()).toEqual({ topics: ['t1'], channels: ['dev'] })
    expect(h.live(TOPIC_Q)).toHaveLength(0)
    expect(h.live(CHANNEL_Q)).toHaveLength(0)

    // The retry succeeds — the joins restore the feeds, with the NEW id.
    h.failIntroduce(false)
    await t.introduce({ sessionName: 'b' })
    await t.joinChannel({ sessionName: 'b', channel: 'dev' })
    await t.joinTopic({ sessionName: 'b', topicId: 't1' })

    expect(t.suspendedFeeds()).toEqual({ topics: [], channels: [] })
    expect(h.live(TOPIC_Q)[0]!.args).toMatchObject({ sessionId: 'session_b' })
    expect(h.live(CHANNEL_Q)[0]!.args).toMatchObject({ sessionId: 'session_b' })

    // And it really delivers again, through the ORIGINAL callbacks.
    h.live(TOPIC_Q)[0]!.cb([{ _id: 'm9', fromSessionId: 'peer', text: 'healed-topic', ts: 20 }])
    h.live(CHANNEL_Q)[0]!.cb([{ _id: 'm8', fromSessionId: 'peer', text: 'healed-chan', ts: 21 }])
    expect(topicMsgs).toEqual(['healed-topic'])
    expect(channelMsgs).toEqual(['healed-chan'])
  })

  it('is idempotent: subscribing the same feed twice registers only one', async () => {
    // The duplicate-feed bug, structurally impossible: the registry is keyed by
    // topic id / channel name, so a re-subscribe cannot stack a second feed.
    const h = makeHarness()
    const t = makeTransport(h)
    await bootWithBothFeeds(t)

    t.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})
    t.subscribeChannelMessages({ channelName: 'dev' }, () => {})

    expect(h.live(TOPIC_Q)).toHaveLength(1)
    expect(h.live(CHANNEL_Q)).toHaveLength(1)
  })

  it('keys channel feeds case-insensitively', async () => {
    // The third KAI-408 bug: a channel-key case mismatch made the location look
    // permanently un-subscribed and stacked a duplicate feed on every rebind.
    const h = makeHarness()
    const t = makeTransport(h)
    await bootWithBothFeeds(t)

    t.subscribeChannelMessages({ channelName: 'DEV' }, () => {})
    expect(h.live(CHANNEL_Q)).toHaveLength(1)

    await t.leaveChannel({ sessionName: 'a', channel: 'Dev' })
    expect(h.live(CHANNEL_Q)).toHaveLength(0)
    expect(t.suspendedFeeds().channels).toEqual(['dev'])
  })

  it('discards topic feeds on an ORG change rather than suspending them', async () => {
    // Topic ids belong to the OLD org — meaningless in the new one, and
    // re-subscribing them would trip the backend's org assertion. The transport
    // knows its own org binding, so it drops them itself; nothing is left
    // suspended forever pretending the session is deaf.
    const h = makeHarness({ sessionIds: ['session_a', 'session_b'] })
    const t = makeTransport(h)
    await bootWithBothFeeds(t, { organizationId: 'org_1' })

    await t.introduce({ sessionName: 'a', organizationId: 'org_2' })

    // The topic feed is GONE, not suspended.
    expect(t.suspendedFeeds().topics).toEqual([])
    expect(h.live(TOPIC_Q)).toHaveLength(0)
    // The channel feed only suspends — channels re-resolve by name in the new org.
    expect(t.suspendedFeeds().channels).toEqual(['dev'])
    await t.joinChannel({ sessionName: 'a', channel: 'dev' })
    expect(t.suspendedFeeds().channels).toEqual([])
    expect(h.live(CHANNEL_Q)).toHaveLength(1)
  })

  it('forgets a feed entirely on a DELIBERATE leave, so it is not reported as deaf', async () => {
    // leaveTopic/leaveChannel cannot tell a migration's transient leave from a
    // deliberate one, so intent is signalled by the tool via forget*Feed.
    const h = makeHarness()
    const t = makeTransport(h)
    await bootWithBothFeeds(t)

    await t.leaveTopic({ sessionName: 'a', topicId: 't1' })
    t.forgetTopicFeed('t1')
    await t.leaveChannel({ sessionName: 'a', channel: 'dev' })
    t.forgetChannelFeed('dev')

    // Deliberately gone ⇒ not suspended, not deaf, and a later join does NOT
    // silently resurrect a feed the user asked to drop.
    expect(t.suspendedFeeds()).toEqual({ topics: [], channels: [] })
    await t.joinChannel({ sessionName: 'a', channel: 'dev' })
    await t.joinTopic({ sessionName: 'a', topicId: 't1' })
    expect(h.live(TOPIC_Q)).toHaveLength(0)
    expect(h.live(CHANNEL_Q)).toHaveLength(0)
  })
})

/**
 * Three NEGATIVES that the suite never pinned — each one could be removed with
 * the suite still green, which means the behaviour they protect was load-bearing
 * but unguarded.
 */
describe('RemoteTransport feed lifecycle — the negatives', () => {
  it('restoring a channel feed does NOT restore the topic feeds inside it', async () => {
    // The backend's listByTopic asserts CHANNEL presence *and* TOPIC membership.
    // On a rebind the channel is re-joined before the topics are, so a topic feed
    // re-attached by the channel's restore would query while its topic membership
    // is still gone -> ConvexError -> registerSubscriptionFailure -> three of
    // those disable the whole transport. Only `joinTopic` may restore a topic.
    const h = makeHarness({ sessionIds: ['session_1', 'session_2'] })
    const transport = new RemoteTransport({ client: h.client, source: 'remote', log: () => {} })

    await transport.introduce({ sessionName: 'bootstrap' })
    await transport.joinChannel({ sessionName: 'bootstrap', channel: 'dev' })
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    transport.subscribeTopicMessages({ topicId: 'topic_1', channelName: 'dev' }, () => {})
    await transport.joinTopic({ sessionName: 'bootstrap', topicId: 'topic_1' })
    expect(transport.suspendedFeeds()).toEqual({ topics: [], channels: [] })

    // The rebind suspends both.
    await transport.introduce({ sessionName: 'renamed' })
    expect(transport.suspendedFeeds()).toEqual({ topics: ['topic_1'], channels: ['dev'] })

    // Re-joining ONLY the channel must revive ONLY the channel.
    await transport.joinChannel({ sessionName: 'renamed', channel: 'dev' })
    expect(transport.hasLiveChannelFeed('dev')).toBe(true)
    expect(transport.hasLiveTopicFeed('topic_1')).toBe(false)
    expect(transport.suspendedFeeds()).toEqual({ topics: ['topic_1'], channels: [] })

    // The topic comes back only when its own membership does.
    await transport.joinTopic({ sessionName: 'renamed', topicId: 'topic_1' })
    expect(transport.hasLiveTopicFeed('topic_1')).toBe(true)
  })

  it('does not restore feeds on a transport that has been shut down', async () => {
    // shutdown() detaches every feed and closes the client. A join arriving after
    // that (an in-flight tool call losing the race) must not resurrect a feed
    // against a dead ConvexClient.
    const h = makeHarness()
    const transport = new RemoteTransport({ client: h.client, source: 'remote', log: () => {} })

    await transport.introduce({ sessionName: 'me' })
    await transport.joinChannel({ sessionName: 'me', channel: 'dev' })
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    transport.subscribeTopicMessages({ topicId: 'topic_1', channelName: 'dev' }, () => {})
    await transport.joinTopic({ sessionName: 'me', topicId: 'topic_1' })

    await transport.shutdown()
    expect(h.live('messages:listByChannel')).toHaveLength(0)
    expect(h.live('messages:listByTopic')).toHaveLength(0)

    // A late join must NOT re-attach anything.
    await transport.joinChannel({ sessionName: 'me', channel: 'dev' })
    await transport.joinTopic({ sessionName: 'me', topicId: 'topic_1' })
    expect(h.live('messages:listByChannel')).toHaveLength(0)
    expect(h.live('messages:listByTopic')).toHaveLength(0)
    expect(transport.hasLiveChannelFeed('dev')).toBe(false)
    expect(transport.hasLiveTopicFeed('topic_1')).toBe(false)
  })

  it('shutdown() detaches every live feed', async () => {
    // The replace-in-place path in attachLocation now relies ENTIRELY on
    // shutdown() to tear the prior transport's feeds down — it no longer sweeps
    // shared unsubscribe maps itself. If shutdown stopped detaching, the old
    // transport's feeds would keep firing into the MessageBus alongside the new
    // transport's, which is duplicate delivery from a session that is supposed
    // to be gone.
    const h = makeHarness()
    const transport = new RemoteTransport({ client: h.client, source: 'remote', log: () => {} })

    await transport.introduce({ sessionName: 'me' })
    await transport.joinChannel({ sessionName: 'me', channel: 'dev' })
    transport.subscribeChannelMessages({ channelName: 'dev' }, () => {})
    transport.subscribeTopicMessages({ topicId: 'topic_1', channelName: 'dev' }, () => {})
    await transport.joinTopic({ sessionName: 'me', topicId: 'topic_1' })
    expect(h.live('messages:listByChannel')).toHaveLength(1)
    expect(h.live('messages:listByTopic')).toHaveLength(1)

    await transport.shutdown()

    expect(h.live('messages:listByChannel')).toHaveLength(0)
    expect(h.live('messages:listByTopic')).toHaveLength(0)
  })
})

/**
 * `attached` must mean "the onUpdate is REALLY registered" — not "we asked for
 * one" (KAI-418, blocker 2).
 *
 * A channel feed subscribed before any `joinChannel` has cached its id must
 * resolve that id asynchronously via `channels:listAll`. That lookup can reject,
 * or return no matching row. In BOTH cases `register()` never runs, so no
 * onUpdate exists and the session cannot hear a thing on that channel — while
 * the feed object, the `inner` handle and the registry entry all exist.
 *
 * If `attached` were set at feed CREATION instead of inside `register()`, every
 * liveness question would lie: `hasLiveChannelFeed` true, `suspendedFeeds`
 * empty, `deafLocations` silent, and the tool would return a clean success on a
 * deaf session. That is the exact defect these pin.
 */
describe('RemoteTransport channel feed — attached means genuinely attached', () => {
  /** Subscribe a channel feed WITHOUT a prior joinChannel, so the async
   *  channel-id lookup (not the cached fast path) is what has to resolve it. */
  async function subscribeWithoutCachedId(
    t: RemoteTransport,
  ): Promise<{ msgs: string[] }> {
    const msgs: string[] = []
    await t.introduce({ sessionName: 'a' })
    t.subscribeChannelMessages({ channelName: 'dev' }, (m: ParsedMessage) => msgs.push(m.text))
    // Let the async id lookup settle.
    await vi.waitFor(() => expect(t.suspendedFeeds).toBeDefined())
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    return { msgs }
  }

  it('is NOT live when the channel-id lookup REJECTS', async () => {
    const h = makeHarness({ listAll: 'reject' })
    const t = makeTransport(h)

    await subscribeWithoutCachedId(t)

    // The lookup was attempted and blew up, so no onUpdate was ever registered.
    expect(h.events).toContain('query:channels:listAll')
    expect(h.live(CHANNEL_Q)).toHaveLength(0)
    // ...and every liveness question tells the truth about it.
    expect(t.hasLiveChannelFeed('dev')).toBe(false)
    expect(t.suspendedFeeds().channels).toContain('dev')
  })

  it('is NOT live when the channel-id lookup finds NO MATCHING channel', async () => {
    const h = makeHarness({ listAll: 'nomatch' })
    const t = makeTransport(h)

    await subscribeWithoutCachedId(t)

    expect(h.live(CHANNEL_Q)).toHaveLength(0)
    expect(t.hasLiveChannelFeed('dev')).toBe(false)
    expect(t.suspendedFeeds().channels).toContain('dev')
  })

  it('recovers: once the id resolves on a later join, the feed goes live and DELIVERS', async () => {
    // A failed lookup must be a SUSPENSION, not a death sentence — the feed
    // stays registered and the next join that resolves the id restores it.
    const h = makeHarness({ listAll: 'reject' })
    const t = makeTransport(h)
    const { msgs } = await subscribeWithoutCachedId(t)
    expect(t.hasLiveChannelFeed('dev')).toBe(false)

    // joinChannel caches the real channel id and restores the suspended feed.
    await t.joinChannel({ sessionName: 'a', channel: 'dev' })

    expect(t.hasLiveChannelFeed('dev')).toBe(true)
    expect(t.suspendedFeeds().channels).not.toContain('dev')

    // And it can actually HEAR — liveness that does not deliver is worthless.
    const feed = h.live(CHANNEL_Q).at(-1)!
    feed.cb([{ _id: 'm1', fromSessionId: 'peer', text: 'hello', ts: 500 }])
    expect(msgs).toEqual(['hello'])
  })
})

/**
 * The topic-side twin of the invariant above.
 *
 * A topic feed needs no async id lookup (topics are addressed by id), so its
 * `onUpdate` registers synchronously and `attached` is set immediately after —
 * which is correct. But "immediately after" is only right because it is AFTER:
 * if the client refuses to register the subscription, no onUpdate exists and the
 * feed is deaf. Nothing pinned that ordering, so marking the feed live at
 * CREATION passed the whole suite. This closes it: `attached` must mean the
 * onUpdate is really there, on both feed kinds.
 */
describe('RemoteTransport topic feed — attached means genuinely attached', () => {
  it('is NOT live when the client refuses to register the onUpdate', async () => {
    const h = makeHarness({ onUpdateThrowsFor: TOPIC_Q })
    const t = makeTransport(h)
    await t.introduce({ sessionName: 'a' })
    await t.joinChannel({ sessionName: 'a', channel: 'dev' })
    await t.joinTopic({ sessionName: 'a', topicId: 't1' })

    // The refusal is not swallowed — but whatever the caller does with it, the
    // feed must never claim to be live.
    expect(() => t.subscribeTopicMessages({ topicId: 't1', channelName: 'dev' }, () => {})).toThrow(/onUpdate refused/)

    expect(h.live(TOPIC_Q)).toHaveLength(0)
    expect(t.hasLiveTopicFeed('t1')).toBe(false)
    expect(t.suspendedFeeds().topics).toContain('t1')
  })
})
