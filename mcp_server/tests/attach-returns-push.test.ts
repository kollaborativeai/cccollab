import { describe, it, expect, vi } from 'vitest'

import { ensureChannelSubscription, ensureTopicSubscription } from '../src/transport/attach.js'
import type { MessageBus } from '../src/message-bus.js'
import type { Transport } from '../src/transport/index.js'
import type { ParsedMessage } from '../src/types.js'

/**
 * THE PRODUCTION `onEvent` MUST RETURN THE PUSH PROMISE.
 *
 * `RemoteTransport` withholds `ackChannel` / `channelMaxTs` / `topicMaxTs` until
 * the promise its `onEvent` returns settles — that is the whole of the C2 fix.
 * `ensureChannelSubscription` / `ensureTopicSubscription` are that `onEvent` in
 * production, and they do return `messageBus.push(...)`. Nothing noticed if they
 * stopped: voiding both call sites left 202 related tests and `tsc --noEmit`
 * green, because `attach.test.ts` only asserts `push` was CALLED and every C2
 * test in `remote/transport.test.ts` injects its own callback.
 *
 * That made C2 one careless edit — or one merge with any of the open PRs that
 * touch `attach.ts` — away from being fiction while its own named tests stayed
 * green. `void push(...)` returns `undefined`, `Promise.resolve(undefined)`
 * settles on the next tick, and the cursor advances over an image that is still
 * downloading; a crash in that window loses the row permanently.
 *
 * So this asserts the LINK rather than the call: the value handed back must not
 * settle before `push` does. Replace either `return` with `void` and the
 * "still pending" assertion goes RED.
 */

async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** A push we can hold open, so "did the callback wait for it" is observable. */
function deferredBus(): { bus: MessageBus; push: ReturnType<typeof vi.fn>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const push = vi.fn(() => gate)
  return { bus: { push } as unknown as MessageBus, push, release }
}

const message: ParsedMessage = {
  sender: 'web-user',
  text: 'here is the screenshot',
  ts: new Date(1_700_000_000_000).toISOString(),
  channel: 'c1',
  channelName: 'general',
  threadTs: undefined,
}

/**
 * Drive whatever the subscription handed the transport, and report whether its
 * return value is still pending while `push` is.
 */
async function observeCallback(captured: (msg: ParsedMessage) => unknown, release: () => void) {
  const returned = captured(message)
  let settled = false
  void Promise.resolve(returned).then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await tick()
  const settledWhilePushPending = settled
  release()
  await tick()
  return { settledWhilePushPending, settledAfterPushResolved: settled }
}

describe('attach wiring returns the push promise', () => {
  it('channel subscription does not settle before push does', async () => {
    const { bus, push, release } = deferredBus()
    let captured: ((msg: ParsedMessage) => unknown) | undefined
    const transport = {
      source: 'remote',
      subscribeChannelMessages: vi.fn((_args: { channelName: string }, onEvent: (msg: ParsedMessage) => unknown) => {
        captured = onEvent
        return () => {}
      }),
    } as unknown as Transport

    ensureChannelSubscription({
      transport,
      locationName: 'loc',
      channelName: 'general',
      messageBus: bus,
      map: new Map<string, () => void>(),
    })

    expect(captured).toBeDefined()
    const observed = await observeCallback(captured!, release)

    expect(push).toHaveBeenCalledTimes(1)
    // The load-bearing one: `void push(...)` makes this true and the ack races
    // the download.
    expect(observed.settledWhilePushPending).toBe(false)
    expect(observed.settledAfterPushResolved).toBe(true)
  })

  it('topic subscription does not settle before push does', async () => {
    const { bus, push, release } = deferredBus()
    let captured: ((msg: ParsedMessage) => unknown) | undefined
    const transport = {
      source: 'remote',
      primeTopicCursor: vi.fn(),
      subscribeTopicMessages: vi.fn(
        (_args: { topicId: string; channelName: string }, onEvent: (msg: ParsedMessage) => unknown) => {
          captured = onEvent
          return () => {}
        },
      ),
    } as unknown as Transport

    ensureTopicSubscription({
      transport,
      locationName: 'loc',
      topicId: 't1',
      channelName: 'general',
      messageBus: bus,
      map: new Map<string, () => void>(),
    })

    expect(captured).toBeDefined()
    const observed = await observeCallback(captured!, release)

    expect(push).toHaveBeenCalledTimes(1)
    expect(observed.settledWhilePushPending).toBe(false)
    expect(observed.settledAfterPushResolved).toBe(true)
  })
})
