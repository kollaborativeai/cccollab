import type { ResolvedLocation } from '../config/resolve.js'
import type { ActiveContext } from '../context.js'
import type { TransportRouter } from '../transport/router.js'
import { RemoteTransport } from '../transport/remote.js'

/** Access-token freshness, derived from `accessTokenExpiresAt` without a
 *  network call. `none` means there is no access token at all. A token can
 *  be `expired` while the location is still `loggedIn` - the refresh token
 *  mints a new access token on the next attach. */
export type TokenStatus = 'valid' | 'expiringSoon' | 'expired' | 'none'

/** One location as surfaced by `list_locations`. Pure reporting: nothing
 *  here opens a connection. */
export interface LocationSummary {
  name: string
  isLocal: boolean
  url?: string
  /** A live transport for this location exists in the router right now. */
  attached: boolean
  /** This location owns the session's current active channel. */
  active: boolean
  /** A refresh token is on disk - the credential chain exists, so the
   *  location can mint an access token on demand even if the current one
   *  is expired. Always false for the local broker. */
  loggedIn: boolean
  tokenStatus: TokenStatus
  /** Has everything `defaultTransportFactory` needs: url + tokens +
   *  Clerk app pointer. A logged-in location can still be unconstructable
   *  (e.g. legacy entry missing clerkIssuer/clerkClientId). */
  constructable: boolean
  /** Configured channel names that auto-subscribe when this location attaches. */
  channelsConfigured: string[]
  /** Set only when an attached transport has self-disabled. */
  degradation?: string
}

/** A token within this window of expiry is reported `expiringSoon` rather
 *  than `valid`, so the list flags credentials that are about to roll over.
 *  Five minutes is a human-meaningful heads-up, well above the 10s refresh
 *  margin used internally by the auth layer. */
export const EXPIRING_SOON_MS = 5 * 60_000

function tokenStatus(location: ResolvedLocation, now: number): TokenStatus {
  if (!location.accessToken) return 'none'
  // An access token with no recorded expiry can't be proven stale; treat
  // it as valid rather than guess.
  if (location.accessTokenExpiresAt === undefined) return 'valid'
  const remaining = location.accessTokenExpiresAt - now
  if (remaining <= 0) return 'expired'
  if (remaining <= EXPIRING_SOON_MS) return 'expiringSoon'
  return 'valid'
}

/**
 * Summarize every configured location for `list_locations`. Pure and
 * side-effect free: it reads the resolved config plus a snapshot of which
 * locations are attached, and reports state. `now` is injected so token
 * freshness is deterministic in tests.
 *
 * `attached` is keyed by location name; presence means a live transport
 * is in the router. Its `degradation` (if any) is carried through.
 */
export function summarizeLocations(args: {
  locations: ResolvedLocation[]
  activeChannelLocation?: string
  attached: Map<string, { enabled: boolean; degradation?: string }>
  now: number
}): LocationSummary[] {
  return args.locations.map((location): LocationSummary => {
    const attachedEntry = args.attached.get(location.name)
    const loggedIn = !location.isLocal && Boolean(location.refreshToken)
    const constructable =
      !location.isLocal &&
      Boolean(location.url) &&
      Boolean(location.accessToken) &&
      Boolean(location.refreshToken) &&
      Boolean(location.clerkIssuer) &&
      Boolean(location.clerkClientId)

    return {
      name: location.name,
      isLocal: location.isLocal,
      ...(location.url ? { url: location.url } : {}),
      attached: attachedEntry !== undefined,
      active: args.activeChannelLocation === location.name,
      loggedIn,
      tokenStatus: location.isLocal ? 'none' : tokenStatus(location, args.now),
      constructable,
      channelsConfigured: location.channels.map((c) => c.name),
      ...(attachedEntry?.degradation ? { degradation: attachedEntry.degradation } : {}),
    }
  })
}

export interface LocationToolDeps {
  router: TransportRouter
  locations: ResolvedLocation[]
  context: ActiveContext
}

/**
 * `list_locations` handler. Reports every configured location (global +
 * project + the reserved `local`) with attach and login state, so a user
 * can see locations they are logged into even with nothing joined. Read
 * only - it never opens a connection or refreshes a token.
 */
export function handleListLocations(deps: LocationToolDeps, now: number = Date.now()): string {
  const attached = new Map<string, { enabled: boolean; degradation?: string }>()
  for (const transport of deps.router.all()) {
    const maybeDegraded = transport as Partial<RemoteTransport>
    const degradation = typeof maybeDegraded.degradation === 'string' ? maybeDegraded.degradation : undefined
    attached.set(transport.source, { enabled: transport.enabled, ...(degradation ? { degradation } : {}) })
  }

  const summaries = summarizeLocations({
    locations: deps.locations,
    activeChannelLocation: deps.context.getActiveChannelRef()?.location,
    attached,
    now,
  })

  return JSON.stringify({ locations: summaries })
}
