/**
 * cc#34 FINDING-34 — `reconcileFeeds` must not advance a channel's delivered
 * high-water mark.
 *
 * `joinChannel` already states this invariant for its own path: "A re-join must
 * NOT touch an existing cursor: the value there is the delivered high-water
 * mark, and advancing it to the channel's current `latestTs` would skip every
 * broadcast that arrived in (delivered, latestTs] because
 * `subscribeChannelMessages` resumes at `sinceTs = channelMaxTs` EXCLUSIVE."
 * `reconcileFeeds` was priming that same cursor to `Date.now()`, which is the
 * same skip with a worse bound — and it runs on EVERY introduce
 * (`tools/identity.ts`), not only on a transport swap.
 *
 * Driven through the real `RemoteTransport` so the cursor, the id cache and the
 * query args are production's own, not a stand-in's.
 */
import { describe, it, expect, vi } from 'vitest'
import { getFunctionName } from 'convex/server'
import type { ConvexClient } from 'convex/browser'
import { RemoteTransport } from '../../src/transport/remote.js'
import { reconcileFeeds } from '../../src/transport/attach.js'
import { ActiveContext } from '../../src/context.js'
import type { MessageBus } from '../../src/message-bus.js'

/** The high-water mark the session has actually been delivered up to. */
const DELIVERED_TS = 1_000

function makeTransport() {
  const onUpdate = vi.fn(() => () => {})
  const client = {
    query: vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as never)
      if (name.includes('listAll')) return [{ _id: 'chan_1', name: 'kai' }]
      return []
    }),
    mutation: vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as never)
      if (name.includes('introduce')) return 'session_1'
      if (name.includes('channels') && name.includes('join')) {
        return { channelId: 'chan_1', subscriberCount: 1, latestTs: DELIVERED_TS }
      }
      return undefined
    }),
    onUpdate,
    setAuth: vi.fn(),
    close: vi.fn(),
  }
  const transport = new RemoteTransport({ client: client as unknown as ConvexClient, source: 'remote', log: () => {} })
  const feedArgs = (): Record<string, unknown> | undefined =>
    onUpdate.mock.calls.length > 0
      ? ((onUpdate.mock.calls[onUpdate.mock.calls.length - 1] as unknown[])[1] as Record<string, unknown>)
      : undefined
  return { transport, feedArgs }
}

const bus = { push: vi.fn(async () => {}) } as unknown as MessageBus

describe('cc#34 FINDING-34 — reconcileFeeds and the channel cursor', () => {
  it('does not advance the delivered cursor of a channel it recreates a feed for', async () => {
    // RED without the fix: `primeChannelCursor(ch.name, Date.now())` fires for
    // real here — the id IS cached, which is the case on every introduce after
    // the first join — so the recreated feed resumes at `now` and every
    // broadcast in (DELIVERED_TS, now] is skipped, silently.
    const { transport, feedArgs } = makeTransport()
    await transport.introduce({ sessionName: 'a' })
    await transport.joinChannel({ sessionName: 'a', channel: 'kai' })

    const context = new ActiveContext()
    context.joinChannel('kai', 'cccollab.json', 'remote')

    const beforeReconcile = Date.now()
    reconcileFeeds({ transport, location: 'remote', context, messageBus: bus })

    const args = feedArgs()
    expect(args, 'reconcileFeeds must have created the channel feed').toBeDefined()
    expect(args?.sinceTs).toBe(DELIVERED_TS)
    // Belt and braces: whatever it is, it must not be "now".
    expect(typeof args?.sinceTs === 'number' ? (args.sinceTs as number) : 0).toBeLessThan(beforeReconcile)
  })

  it('leaves a swapped-in transport with no cursor, so the backend read cursor decides', async () => {
    // Guard, not a RED proof: this passed before the fix too, because
    // `primeChannelCursor` returns early when `channelIdsByName` has no entry —
    // and a transport swapped in by `attachLocation` has an empty map, which is
    // the entire case the prime was written for. Pinned so the dead-on-arrival
    // half cannot be "restored" later on the belief that it ever did something.
    const { transport, feedArgs } = makeTransport()
    await transport.introduce({ sessionName: 'a' })

    const context = new ActiveContext()
    context.joinChannel('kai', 'cccollab.json', 'remote')

    reconcileFeeds({ transport, location: 'remote', context, messageBus: bus })
    await new Promise((r) => setTimeout(r, 20)) // id resolves via listAll

    const args = feedArgs()
    expect(args, 'reconcileFeeds must have created the channel feed').toBeDefined()
    expect(args).not.toHaveProperty('sinceTs')
  })
})
