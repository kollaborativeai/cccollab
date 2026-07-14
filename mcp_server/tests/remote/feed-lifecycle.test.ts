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

function makeHarness(opts?: { sessionIds?: string[]; joinLatestTs?: number[] }): Harness {
  const events: string[] = []
  const feeds: Feed[] = []
  const sessionIds = opts?.sessionIds ?? ['session_1']
  const joinLatestTs = opts?.joinLatestTs ?? []
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
        return [
          { channelId: 'chan_dev', name: 'dev' },
          { channelId: 'chan_ops', name: 'ops' },
        ]
      }
      return []
    }),
    onUpdate: vi.fn((ref: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void) => {
      const name = shortName(ref)
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
