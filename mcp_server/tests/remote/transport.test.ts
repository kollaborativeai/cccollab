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
}

function makeStubClient(queryImpl: () => Promise<unknown>): StubClientHandle {
  // Only the methods RemoteTransport touches need to exist. The rest of
  // ConvexClient's surface isn't relevant to this test. Cast through
  // `unknown` to satisfy the structural type without importing the
  // whole client.
  const queryMock = vi.fn(queryImpl)
  const stub = {
    query: queryMock,
    mutation: vi.fn(async () => undefined),
    onUpdate: vi.fn(() => () => {}),
    setAuth: vi.fn(),
  }
  return { client: stub as unknown as ConvexClient, queryMock }
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
