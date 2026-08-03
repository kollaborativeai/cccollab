/**
 * KAI-417 bug 2, exercised through the REAL path: a real RemoteTransport
 * (whose `introduce` rethrows after registerFailure) behind a real
 * TransportRouter, dispatched via the real `handleIdentityTool`. The only
 * stub is the ConvexClient at the network boundary, which rejects the
 * introduce mutation the way the backend does for an unknown organization.
 *
 * Before the fix, identity.ts swallowed that rejection in a bare `catch {}`
 * and introduce reported a cheerful success while the org bind never
 * happened.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ConvexClient } from 'convex/browser'

import { RemoteTransport } from '../../src/transport/remote.js'
import { TransportRouter } from '../../src/transport/router.js'
import { handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

function stubClient(mutationImpl: (...a: unknown[]) => Promise<unknown>): ConvexClient {
  return {
    query: vi.fn(async () => []),
    mutation: vi.fn(mutationImpl),
    onUpdate: vi.fn(() => () => {}),
    setAuth: vi.fn(),
  } as unknown as ConvexClient
}

function deps(router: TransportRouter): IdentityToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    context: new ActiveContext(),
    router,
  }
}

describe('KAI-417: introduce surfaces resolver errors instead of swallowing them', () => {
  it('reports the backend rejection for an invalid organization', async () => {
    // The backend rejects an unknown org id from sessions:introduce.
    const client = stubClient(async () => {
      throw new Error('Organization not found: not-a-real-org')
    })
    const transport = new RemoteTransport({ client, source: 'remote', log: () => {} })
    const router = new TransportRouter([transport])

    const raw = await handleIdentityTool('introduce', { name: 'KAI-417', organization: 'not-a-real-org' }, deps(router))
    const res = JSON.parse(raw) as { name: string; errors?: Array<{ location: string; message: string }> }

    expect(res.errors).toBeDefined()
    expect(res.errors).toHaveLength(1)
    expect(res.errors![0]!.location).toBe('remote')
    expect(res.errors![0]!.message).toContain('Organization not found')
  })

  it('omits `errors` when the bind actually succeeds', async () => {
    const client = stubClient(async () => 'session_123')
    const transport = new RemoteTransport({ client, source: 'remote', log: () => {} })
    const router = new TransportRouter([transport])

    const raw = await handleIdentityTool('introduce', { name: 'KAI-417', organization: 'org_real' }, deps(router))
    const res = JSON.parse(raw) as { name: string; errors?: unknown }

    expect(res.name).toBe('KAI-417')
    expect(res.errors).toBeUndefined()
  })
})

/**
 * KAI-417 F3: the `introduce` tool's own description must tell the caller the
 * `errors` field exists. The consumer is an LLM: it will not react to a
 * failure signal it was never told to look for, which would re-create the
 * silent-success bug at the prompt layer even though the wire format is now
 * correct.
 */
describe('KAI-417: the introduce tool description advertises the errors field', () => {
  it('mentions `errors` so an LLM caller knows to check for a failed bind', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf-8')
    const introduceBlock = src.slice(src.indexOf("registerTool(\n    'introduce'"), src.indexOf("'whoami'"))
    expect(introduceBlock).toMatch(/errors/)
  })
})
