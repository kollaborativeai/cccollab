/**
 * cc#41 FINDING-41a — every tool that reports per-location health must report
 * the SAME health.
 *
 * KAI-516 added `partialDegradation`: an enabled transport with one capability
 * silently reduced (e.g. `channels.listForUser` missing, so the caller's own
 * row under-reports its channels). `whoami` was taught to surface it;
 * `list_locations` — the tool whose stated job is per-location attach and
 * health state — was not, and reported a clean bill of health for the same
 * location. Both now read `transportHealth`, so a health fact cannot reach one
 * and not the other.
 */
import { describe, it, expect, vi } from 'vitest'
import { handleIdentityTool } from '../../src/tools/identity.js'
import { handleListLocations } from '../../src/tools/locations.js'
import { TransportRouter } from '../../src/transport/router.js'
import { ActiveContext } from '../../src/context.js'
import { SessionManager } from '../../src/session.js'
import type { Transport } from '../../src/transport/index.js'
import type { ResolvedLocation } from '../../src/config/resolve.js'

const IMPAIRMENT = 'Own channel memberships unavailable: channels.listForUser not found on deployment'

/** Enabled, working, and quietly incomplete — the state KAI-516 introduced. */
const partiallyDegraded = {
  source: 'remote',
  enabled: true,
  degradation: null,
  partialDegradation: IMPAIRMENT,
  hasTopic: () => false,
  introduce: async () => {},
} as unknown as Transport

/** Self-disabled: the harder failure, which must still outrank the softer one. */
const selfDisabled = {
  source: 'remote',
  enabled: false,
  degradation: 'auth failed',
  partialDegradation: IMPAIRMENT,
  hasTopic: () => false,
  introduce: async () => {},
} as unknown as Transport

const LOCATIONS: ResolvedLocation[] = [{ name: 'remote', isLocal: false, url: 'https://x.convex.cloud', channels: [] }]

async function whoamiFor(transport: Transport): Promise<string> {
  const session = new SessionManager({ username: 'stefan', cwd: '/p' })
  session.setName('orchestrator')
  return handleIdentityTool(
    'whoami',
    {},
    { session, context: new ActiveContext(), router: new TransportRouter([transport]) },
  )
}

function listLocationsFor(transport: Transport): string {
  return handleListLocations({
    router: new TransportRouter([transport]),
    locations: LOCATIONS,
    context: new ActiveContext(),
  })
}

describe('cc#41 FINDING-41a — whoami and list_locations report the same health', () => {
  it('list_locations reports a partial degradation on a still-enabled location', async () => {
    // RED without the fix: list_locations read `degradation` alone, which is
    // null for a partial degradation by construction, so the key was absent
    // entirely — `attached: true` and nothing else.
    const listed = JSON.parse(listLocationsFor(partiallyDegraded)) as {
      locations: Array<{ name: string; attached: boolean; degradation?: string }>
    }
    expect(listed.locations[0]?.attached).toBe(true)
    expect(listed.locations[0]?.degradation).toBe(IMPAIRMENT)
  })

  it('agrees with whoami on the same transport', async () => {
    // The property that actually matters: not "list_locations says X" but
    // "the two tools cannot disagree".
    const whoami = JSON.parse(await whoamiFor(partiallyDegraded)) as {
      locations: Record<string, { enabled: boolean; degradation?: string }>
    }
    const listed = JSON.parse(listLocationsFor(partiallyDegraded)) as {
      locations: Array<{ name: string; attached: boolean; degradation?: string }>
    }
    expect(listed.locations[0]?.degradation).toBe(whoami.locations.remote?.degradation)
    expect(listed.locations[0]?.attached).toBe(whoami.locations.remote?.enabled)
  })

  it('a self-disable still outranks a reduced capability, on both surfaces', async () => {
    // Non-vacuity: unifying the readers must not flatten the precedence. "Off"
    // is the actionable fact when both are present.
    const whoami = JSON.parse(await whoamiFor(selfDisabled)) as {
      locations: Record<string, { enabled: boolean; degradation?: string }>
    }
    const listed = JSON.parse(listLocationsFor(selfDisabled)) as {
      locations: Array<{ degradation?: string }>
    }
    expect(whoami.locations.remote?.degradation).toBe('auth failed')
    expect(whoami.locations.remote?.enabled).toBe(false)
    expect(listed.locations[0]?.degradation).toBe('auth failed')
  })
})
