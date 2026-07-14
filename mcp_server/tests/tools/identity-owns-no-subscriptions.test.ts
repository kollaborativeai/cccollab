import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Architecture fitness function (KAI-418).
 *
 * KAI-408 shipped three separate bugs — feeds left bound to a stale sessionId, a
 * degraded rename that could never self-heal, and a channel-key case mismatch
 * that stacked a duplicate feed on every re-introduce. All three came from ONE
 * seam: the identity TOOL keeping subscription BOOKKEEPING in sync with
 * transport state (sessionId, channel ids, cursors) that it did not own. Each
 * fix made the remembering more careful. This test removes the need to remember.
 *
 * The boundary this pins is BOOKKEEPING, not CREATION. An earlier version of
 * this test banned `ensure*Subscription` from the tool outright — that ban is
 * unsound, and enforcing it is precisely what let a session go silently deaf:
 * only the tool layer holds the MessageBus callback a feed is built from, and a
 * transport that was just swapped in place has an EMPTY registry, so there is
 * nothing there to "restore" — its feeds must be CREATED, and the tool is the
 * only layer that can create them. Creation therefore stays tool-side, funnelled
 * through the single `reconcileFeeds` helper that owns the invariant.
 *
 * What must never come back is the PARALLEL COPY: the tool re-deriving, storing
 * or keying subscription state of its own — `${location}::${key}` maps, per-key
 * stale detection, hand-rolled teardown/resubscribe orchestration. The transport
 * owns feed LIFECYCLE (suspend on rebind, restore on re-join, forget on a
 * deliberate leave); the tool re-joins MEMBERSHIPS, asks the transport whether it
 * can actually hear, and reports the truth.
 *
 * If this fails, someone has moved subscription bookkeeping back into the tool
 * layer, and the whole bug class comes back with it. Do not "fix" it by adding
 * the symbol to the allowlist — put the behaviour in the transport, or behind
 * `reconcileFeeds`.
 */
describe('architecture: tools/identity.ts owns no subscription bookkeeping', () => {
  const source = (): string =>
    readFileSync(fileURLToPath(new URL('../../src/tools/identity.ts', import.meta.url)), 'utf8')

  /** Comments explain what the tool no longer does, and naming the banned shape
   *  in prose is how that stays understood. Only CODE is under the ban. */
  const code = (): string =>
    source()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

  it('never drives a feed directly — feed work goes through reconcileFeeds', () => {
    // Reaching for the transport's own feed methods by hand is the tool taking
    // the lifecycle back. Creating feeds is legitimate — but only via
    // `reconcileFeeds`, which enforces the membership-driven invariant in ONE
    // place for both of its callers (this tool, and `attachLocation`).
    const FORBIDDEN = [
      'subscribeTopicMessages',
      'subscribeChannelMessages',
      'forgetTopicFeed',
      'forgetChannelFeed',
      'primeTopicCursor',
      'forgetChannelCursor',
    ]

    const found = FORBIDDEN.filter((symbol) => code().includes(symbol))

    expect(
      found,
      `tools/identity.ts must not drive feeds directly — RemoteTransport owns their lifecycle, and reconcileFeeds owns the invariant (KAI-418). Found: ${found.join(', ')}`,
    ).toEqual([])
  })

  it('holds no parallel subscription bookkeeping of its own', () => {
    const src = code()

    // The `${location}::${key}` maps the tool used to keep in parallel with the
    // transport. A case mismatch in exactly that key is what made a channel look
    // permanently un-subscribed (b633e4d). There is no parallel copy any more.
    expect(src).not.toContain('remoteTopicUnsubscribes')
    expect(src).not.toContain('remoteChannelUnsubscribes')
    // Nor any re-derivation of the transport's private key shape.
    expect(src).not.toMatch(/\$\{[a-zA-Z.]*[lL]ocation[a-zA-Z.]*\}::/)
    // Deafness is ASKED of the transport, per membership — never inferred from
    // its registry. Reading `suspendedFeeds()` as the oracle is exactly what made
    // a MISSING feed (the swapped-transport case) invisible: it can only see
    // deafness that already has an entry.
    expect(src).not.toContain('suspendedFeeds')
  })
})
