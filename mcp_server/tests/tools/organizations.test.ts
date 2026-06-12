import { describe, it, expect } from 'vitest'

import { handleListOrganizations } from '../../src/tools/organizations.js'
import { LocalTransport } from '../../src/transport/local.js'
import { TransportRouter } from '../../src/transport/router.js'
import type { Transport } from '../../src/transport/index.js'
import { ensureLazyAttach, type LazyAttachCtx } from '../../src/transport/attach.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'
import type { MessageBus } from '../../src/message-bus.js'
import type { ResolvedLocation } from '../../src/config/resolve.js'

/**
 * Build a TransportRouter that contains the always-present local transport
 * plus any fake remote transports supplied by the caller. Mirrors the
 * construction pattern used in tests/tools/channels.test.ts.
 */
function makeDepsWithTransports(fakeRemotes: Array<Record<string, unknown>>) {
  const local = new LocalTransport(7850)
  const transports: Transport[] = [local, ...fakeRemotes.map((f) => f as unknown as Transport)]
  const router = new TransportRouter(transports)
  return { router }
}

describe('list_organizations tool', () => {
  it('returns organizations from each enabled remote transport, tagged by location', async () => {
    const fakeRemote = {
      source: 'remote',
      enabled: true,
      listOrganizations: async () => [{ id: 'org_a', name: 'Acme' }],
    }
    const deps = makeDepsWithTransports([fakeRemote])
    const result = JSON.parse(await handleListOrganizations(deps))
    expect(result.organizations).toEqual([{ id: 'org_a', name: 'Acme', location: 'remote' }])
  })

  it('returns an empty list when only the local transport is present', async () => {
    const deps = makeDepsWithTransports([]) // local-only router
    const result = JSON.parse(await handleListOrganizations(deps))
    expect(result.organizations).toEqual([])
  })

  it('skips a failing transport and returns orgs from the remaining working transport', async () => {
    const failingRemote = {
      source: 'remote-a',
      enabled: true,
      listOrganizations: async (): Promise<Array<{ id: string; name: string }>> => {
        throw new Error('network timeout')
      },
    }
    const workingRemote = {
      source: 'remote-b',
      enabled: true,
      listOrganizations: async () => [{ id: 'org_b', name: 'Beta Corp' }],
    }
    const deps = makeDepsWithTransports([failingRemote, workingRemote])
    const result = JSON.parse(await handleListOrganizations(deps))
    expect(result.organizations).toEqual([{ id: 'org_b', name: 'Beta Corp', location: 'remote-b' }])
  })

  it('lazily attaches a dormant token-bearing remote even with no session name (pre-introduce discovery)', async () => {
    // list_organizations is the tool you call BEFORE introduce, to pick an
    // org to introduce with. A session with no name (config has none, no
    // introduce yet) must still get the remote attached so its orgs are
    // listed — otherwise the discovery tool is a chicken-and-egg dead end.
    const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' }) // intentionally un-named
    const context = new ActiveContext()
    const router = new TransportRouter([new LocalTransport(7850)])
    const bus = { push: async () => {} } as unknown as MessageBus
    const fakeRemote = {
      source: 'remote',
      enabled: true,
      introduce: async () => {},
      listOrganizations: async () => [{ id: 'org_a', name: 'Acme' }],
    } as unknown as Transport
    const dormant: ResolvedLocation = {
      name: 'remote',
      isLocal: false,
      url: 'https://example.convex.cloud',
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      clerkIssuer: 'https://x.clerk.accounts.dev',
      clerkClientId: 'cid',
      channels: [],
    }
    const ensureAttached = (target?: string, opts?: { force?: boolean; allowWithoutName?: boolean }) => {
      const ctx: LazyAttachCtx = {
        session,
        context,
        router,
        messageBus: bus,
        remoteTopicUnsubscribes: new Map<string, () => void>(),
        remoteChannelUnsubscribes: new Map<string, () => void>(),
        inflight: new Map<string, Promise<void>>(),
        candidates: ['remote'],
        resolve: () => ({
          locations: [dormant],
          activeLocation: undefined,
          activeChannel: undefined,
          activeTopic: undefined,
        }),
        transportFactory: () => fakeRemote,
      }
      return ensureLazyAttach(target, ctx, opts)
    }

    const result = JSON.parse(await handleListOrganizations({ router, ensureAttached }))
    expect(router.has('remote')).toBe(true)
    expect(result.organizations).toEqual([{ id: 'org_a', name: 'Acme', location: 'remote' }])
  })

  it('skips a remote transport that does not expose listOrganizations', async () => {
    // The capability check in the tool must skip a remote that doesn't
    // implement listOrganizations (for example, a fake transport in a
    // test, or a future transport variant) without throwing — and the
    // org-capable remote still contributes.
    const noOrgRemote = {
      source: 'no-org-surface',
      enabled: true,
    }
    const orgCapableRemote = {
      source: 'clerk-like',
      enabled: true,
      listOrganizations: async () => [{ id: 'org_a', name: 'Acme' }],
    }
    const deps = makeDepsWithTransports([noOrgRemote, orgCapableRemote])
    const result = JSON.parse(await handleListOrganizations(deps))
    expect(result.organizations).toEqual([{ id: 'org_a', name: 'Acme', location: 'clerk-like' }])
  })
})
