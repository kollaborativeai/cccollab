import { describe, it, expect } from 'vitest'

import { handleListOrganizations } from '../../src/tools/organizations.js'
import { LocalTransport } from '../../src/transport/local.js'
import { TransportRouter } from '../../src/transport/router.js'
import type { Transport } from '../../src/transport/index.js'

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
})
