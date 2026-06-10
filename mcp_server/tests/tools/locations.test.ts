import { describe, it, expect } from 'vitest'

import {
  summarizeLocations,
  handleListLocations,
  EXPIRING_SOON_MS,
  type LocationSummary,
} from '../../src/tools/locations.js'
import type { ResolvedLocation } from '../../src/config/resolve.js'
import { ActiveContext } from '../../src/context.js'
import { TransportRouter } from '../../src/transport/router.js'
import { LocalTransport } from '../../src/transport/local.js'

const NOW = 1_000_000_000_000

/** Build a fully-constructable, logged-in non-local location; override per case. */
function remote(partial: Partial<ResolvedLocation> & { name: string }): ResolvedLocation {
  return {
    isLocal: false,
    url: 'https://example.convex.cloud',
    authType: 'clerk',
    accessToken: 'a',
    refreshToken: 'r',
    accessTokenExpiresAt: NOW + 60 * 60_000, // 1h ahead → valid
    clerkIssuer: 'https://example.clerk.accounts.dev',
    clerkClientId: 'cid',
    channels: [],
    ...partial,
  }
}

const local = (channels: ResolvedLocation['channels'] = []): ResolvedLocation => ({
  name: 'local',
  isLocal: true,
  channels,
})

function summarize(
  locations: ResolvedLocation[],
  opts: { activeChannelLocation?: string; attached?: Map<string, { enabled: boolean; degradation?: string }> } = {},
): LocationSummary[] {
  return summarizeLocations({
    locations,
    activeChannelLocation: opts.activeChannelLocation,
    attached: opts.attached ?? new Map(),
    now: NOW,
  })
}

const byName = (rows: LocationSummary[], name: string): LocationSummary => rows.find((r) => r.name === name)!

describe('summarizeLocations', () => {
  it('reports the local location as attached, not logged in, no token', () => {
    const rows = summarize([local([{ name: 'cccollab', topics: [] }])], {
      attached: new Map([['local', { enabled: true }]]),
    })
    const l = byName(rows, 'local')
    expect(l.isLocal).toBe(true)
    expect(l.attached).toBe(true)
    expect(l.loggedIn).toBe(false)
    expect(l.tokenStatus).toBe('none')
    expect(l.constructable).toBe(false)
    expect(l.channelsConfigured).toEqual(['cccollab'])
  })

  it('shows a detached logged-in remote with a valid token', () => {
    const rows = summarize([remote({ name: 'remote' })])
    const r = byName(rows, 'remote')
    expect(r.attached).toBe(false)
    expect(r.loggedIn).toBe(true)
    expect(r.tokenStatus).toBe('valid')
    expect(r.constructable).toBe(true)
    expect(r.url).toBe('https://example.convex.cloud')
  })

  it('classifies a token expiring within the window as expiringSoon', () => {
    const rows = summarize([remote({ name: 'remote', accessTokenExpiresAt: NOW + EXPIRING_SOON_MS - 1 })])
    expect(byName(rows, 'remote').tokenStatus).toBe('expiringSoon')
  })

  it('classifies an elapsed token as expired but still logged in (refresh token present)', () => {
    const rows = summarize([remote({ name: 'remote', accessTokenExpiresAt: NOW - 1 })])
    const r = byName(rows, 'remote')
    expect(r.tokenStatus).toBe('expired')
    expect(r.loggedIn).toBe(true)
  })

  it('reports a token-less configured remote as not logged in, tokenStatus none', () => {
    const rows = summarize([remote({ name: 'remote', accessToken: undefined, refreshToken: undefined })])
    const r = byName(rows, 'remote')
    expect(r.loggedIn).toBe(false)
    expect(r.tokenStatus).toBe('none')
    expect(r.constructable).toBe(false)
  })

  it('marks a logged-in remote missing its Clerk pointer as not constructable', () => {
    const rows = summarize([remote({ name: 'tow123', clerkIssuer: undefined, clerkClientId: undefined })])
    const r = byName(rows, 'tow123')
    expect(r.loggedIn).toBe(true)
    expect(r.constructable).toBe(false)
  })

  it('surfaces attached + degradation state from the router map', () => {
    const rows = summarize([remote({ name: 'remote' })], {
      attached: new Map([['remote', { enabled: false, degradation: 'auth failed' }]]),
    })
    const r = byName(rows, 'remote')
    expect(r.attached).toBe(true)
    expect(r.degradation).toBe('auth failed')
  })

  it('flags the location of the active channel as active', () => {
    const rows = summarize([local(), remote({ name: 'remote' })], { activeChannelLocation: 'remote' })
    expect(byName(rows, 'remote').active).toBe(true)
    expect(byName(rows, 'local').active).toBe(false)
  })

  it('treats a token with no expiry timestamp as valid (cannot prove staleness)', () => {
    const rows = summarize([remote({ name: 'remote', accessTokenExpiresAt: undefined })])
    expect(byName(rows, 'remote').tokenStatus).toBe('valid')
  })

  it('preserves input order and covers every configured location', () => {
    const rows = summarize([remote({ name: 'remote' }), remote({ name: 'tow123' }), local()])
    expect(rows.map((r) => r.name)).toEqual(['remote', 'tow123', 'local'])
  })
})

describe('handleListLocations', () => {
  it('marks the attached local broker active and lists a detached logged-in remote', () => {
    const router = new TransportRouter([new LocalTransport(0)])
    const context = new ActiveContext()
    context.joinChannel('cccollab', 'cccollab.json', 'local')
    context.setActiveChannel('cccollab', 'local')

    const locations: ResolvedLocation[] = [local([{ name: 'cccollab', topics: [] }]), remote({ name: 'remote' })]
    const parsed = JSON.parse(handleListLocations({ router, locations, context }, NOW)) as {
      locations: LocationSummary[]
    }

    const localRow = parsed.locations.find((l) => l.name === 'local')!
    expect(localRow.attached).toBe(true)
    expect(localRow.active).toBe(true)

    const remoteRow = parsed.locations.find((l) => l.name === 'remote')!
    expect(remoteRow.attached).toBe(false)
    expect(remoteRow.active).toBe(false)
    expect(remoteRow.loggedIn).toBe(true)
    expect(remoteRow.tokenStatus).toBe('valid')
  })
})
