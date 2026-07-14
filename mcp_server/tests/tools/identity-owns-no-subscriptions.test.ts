import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Architecture fitness function (KAI-418).
 *
 * KAI-408 shipped three separate bugs — feeds left bound to a stale sessionId, a
 * degraded rename that could never self-heal, and a channel-key case mismatch
 * that stacked a duplicate feed on every re-introduce. All three came from ONE
 * seam: the identity TOOL keeping subscription bookkeeping in sync with
 * transport state (sessionId, channel ids, cursors) that it did not own. Each
 * fix made the remembering more careful. This test removes the need to remember.
 *
 * `RemoteTransport` now owns the lifecycle of its own live feeds: it suspends
 * them when the identity or membership behind them goes away, and re-attaches
 * them on the join that makes them valid again. `tools/identity.ts` re-joins
 * MEMBERSHIPS and reports the truth; it must never again touch a subscription.
 *
 * If this fails, someone has moved subscription bookkeeping back into the tool
 * layer, and the whole bug class comes back with it. Do not "fix" it by adding
 * the symbol to the allowlist — put the behaviour in the transport instead.
 */
describe('architecture: tools/identity.ts owns no subscription bookkeeping', () => {
  const FORBIDDEN = [
    // Creating or tearing down a feed — the transport's job, driven from the
    // join/leave TOOLS (which own the MessageBus callback and the user's intent).
    'subscribeTopicMessages',
    'subscribeChannelMessages',
    'ensureTopicSubscription',
    'ensureChannelSubscription',
    'teardownTopicSubscription',
    'teardownChannelSubscription',
  ]

  it('does not reference any subscription-lifecycle symbol', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/tools/identity.ts', import.meta.url)), 'utf8')

    const found = FORBIDDEN.filter((symbol) => source.includes(symbol))

    expect(
      found,
      `tools/identity.ts must not do subscription bookkeeping — RemoteTransport owns its feeds (KAI-418). Found: ${found.join(', ')}`,
    ).toEqual([])
  })

  it('holds no unsubscribe maps', () => {
    const source = readFileSync(fileURLToPath(new URL('../../src/tools/identity.ts', import.meta.url)), 'utf8')

    // The `${location}::${key}` maps the tool used to keep in parallel with the
    // transport. A case mismatch in exactly that key is what made a channel look
    // permanently un-subscribed (b633e4d). There is no parallel copy any more.
    expect(source).not.toContain('remoteTopicUnsubscribes')
    expect(source).not.toContain('remoteChannelUnsubscribes')
  })
})
