import type { ActiveContext } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import type { TransportRouter } from '../transport/router.js'
import { LOCAL_LOCATION, type ChannelLocation, type Transport } from '../transport/index.js'
import type { RemoteTransport } from '../transport/remote.js'
import { runClerkPkce } from '../remote/auth-clerk.js'
import { saveLocationAuth } from '../config/save.js'
import { attachLocation, hasFeedRegistry, type AttachCtx } from '../transport/attach.js'
import type { AttachDiagnostics } from '../transport/diagnostics.js'
import { resolveConfig, type ResolvedLocation } from '../config/resolve.js'

export interface IdentityToolDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  /** Mutable view of the resolved-config locations. The `authenticate`
   *  tool MUTATES this in place when it hot-attaches a location that
   *  was not previously in the config (e.g. the env-var-only first
   *  sign-in case) so the next tool call sees the new name. */
  locations?: ResolvedLocation[]
  /** The MessageBus the hot-attach path hands to `attachLocation` so
   *  the new transport's topic/channel subscriptions feed inbound
   *  messages back into the session. Optional so existing unit tests
   *  that don't exercise the hot-attach path can continue to construct
   *  deps without a bus. */
  messageBus?: MessageBus
  /** cwd used when re-resolving config on a hot-attach. Defaults to
   *  `process.cwd()` but injectable for tests. */
  cwd?: string
  /** Env used when re-resolving config on a hot-attach. Defaults to
   *  `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Optional override for the transport factory used on hot-attach.
   *  Threads through to `AttachCtx.transportFactory`; production leaves
   *  this undefined so the default factory (which builds a real
   *  `RemoteTransport` wrapping a `ConvexClient`) is used. Unit tests
   *  that exercise the hot-attach wiring without network pass a fake
   *  here. */
  transportFactory?: AttachCtx['transportFactory']
  /** Bring a dormant token-bearing location online on first use. In
   *  `authenticate` this is called before the "already authenticated"
   *  check so a valid remote short-circuits instead of forcing a fresh
   *  sign-in; in `whoami` it makes a configured-and-valid remote report
   *  as enabled. Optional so legacy unit tests keep compiling. See
   *  `ensureLazyAttach`. */
  ensureAttached?: (target?: string, opts?: { force?: boolean }) => Promise<void>
  /** Records of transport attaches that FAILED (introduce error, etc).
   *  A failed remote is deliberately never registered in the router
   *  (KAI-368: the router holds only healthy transports), so `whoami`
   *  reads this separate registry to still surface the location as
   *  disabled + degraded. Optional so legacy unit tests keep compiling. */
  diagnostics?: AttachDiagnostics
}

export async function handleIdentityTool(
  name: string,
  args: Record<string, unknown>,
  deps: IdentityToolDeps,
): Promise<string> {
  switch (name) {
    case 'introduce': {
      const {
        name: displayName,
        objective,
        organization,
      } = args as {
        name: string
        objective?: string
        organization?: string
      }

      const hasRemote = deps.router.enabled().some((t) => t.source !== LOCAL_LOCATION)
      if (hasRemote && !organization) {
        return JSON.stringify({
          error: 'An organization is required. Call list_organizations and pass an id as `organization`.',
        })
      }

      // A session's identity IS its name: the broker keys sessions,
      // channel membership and topic membership by it, and the backend
      // keys CLI sessions by (user, org, sessionName). So a rename is a
      // MIGRATION, not an overwrite - without tearing the old name's
      // memberships down first it lingers as a ghost member of every
      // channel and topic it joined. This is the common path, not an
      // edge case: a session boots under the config's default name,
      // auto-joins its configured channels/topics under it, and only
      // then does the agent introduce itself for real. The prior identity is
      // the EFFECTIVE display name, which falls back to the username when no
      // config `name` was set: server.ts still auto-joins local channels
      // under that username, so it too must be torn down or it lingers as a
      // local ghost. (On the remote transport this is a safe no-op — with no
      // prior introduce its sessionId is null and leave*/join* early-return.)
      const previousName = deps.session.displayName
      const renamed = previousName !== displayName

      // The backend keys a location's row by (user, org, sessionName), so that
      // row REBINDS when the name changes (globally) or when THAT location's
      // org changes. Org is therefore a PER-LOCATION property of the migration.
      //
      // LOCAL is never org-changed: the broker is single-tenant and ignores
      // organizationId entirely. Letting an org switch mark local as changed
      // would tear down and DROP the user's local topics — the most damaging
      // mistake available here.
      //
      // Snapshot this BEFORE the fan-out, which records the NEW bindings and
      // would otherwise make every location look unchanged by the time the
      // topic decisions below are taken.
      const orgChangedLocations = new Set<string>()
      for (const location of membershipLocations(deps)) {
        if (location === LOCAL_LOCATION) continue
        const previousOrg = deps.session.getOrganizationFor(location)
        if (previousOrg !== undefined && organization !== undefined && previousOrg !== organization) {
          orgChangedLocations.add(location)
        }
      }
      const rebinds = (location: ChannelLocation): boolean => renamed || orgChangedLocations.has(location)
      const migrating = renamed || orgChangedLocations.size > 0

      // The third trigger: a location where the transport is holding a SUSPENDED
      // feed — it has membership but cannot deliver on it. That is the
      // fingerprint of an EARLIER migration that failed half-way (its feeds were
      // suspended, its introduce then threw, so it was never re-joined). Without
      // this, the natural fix — the agent retrying under the SAME name — leaves
      // `renamed` false and nothing marks the location as needing work: the
      // ungated channel re-join recreates membership while the TOPIC feeds stay
      // suspended, and the tool reports a clean success while the session is
      // deaf.
      //
      // We ask the TRANSPORT, which owns its feeds, rather than peeking at
      // bookkeeping the tool used to keep in parallel — the parallel copy is
      // precisely where the key-case bug bit us.
      //
      // Snapshotted BEFORE the leaves below, so it reflects the breakage left by
      // the EARLIER attempt, not the suspension we are about to cause.
      const deafBefore = deafLocations(deps)

      // A location needs its topics re-joined if it rebinds (rename / org
      // change) or if it is deaf from a previous failure.
      const restoresAt = (location: ChannelLocation): boolean => rebinds(location) || deafBefore.has(location)
      const restoring = migrating || deafBefore.size > 0

      // The old-identity leave is gated on `migrating` ALONE: a heal has no
      // previous identity to leave.
      if (migrating) {
        // Ordering is load-bearing. RemoteTransport ignores `sessionName`
        // and addresses the backend by its bound session row, which the
        // introduce() fan-out below rebinds to the new name/org - so the old
        // row is only still reachable BEFORE that. That is what actually
        // removes the ghost from the OLD org. LocalTransport keys these calls
        // by `sessionName`, so both transports drop exactly the old identity's
        // memberships. We deliberately do not delete the old session itself:
        // the bootstrap name is shared across the user's concurrently-booting
        // sessions. Only locations that actually REBIND are left — a location
        // that neither renamed nor changed org keeps its memberships.
        //
        // Nothing here touches subscriptions: `RemoteTransport.leaveTopic` /
        // `leaveChannel` suspend their own feeds before issuing the mutation
        // that would invalidate them, and the re-joins below re-attach them
        // under the new session row (KAI-418).
        await leaveUnderPreviousName(deps, previousName, rebinds)
      }

      deps.session.setName(displayName)
      deps.session.setObjective(objective)

      // Identity fans out: every enabled transport learns who we are so
      // it can attribute messages and list us in `list_sessions`. Track
      // which locations actually rebound: introduce() rethrows only AFTER
      // failing to bind its new session row, so a failure leaves that
      // location's id pointing at the pre-rename identity (or the transport
      // self-disabled). Running the joins / resubscribe below against such a
      // location would recreate the old-name ghost under the stale id (or
      // throw-and-swallow into a stranded session) — so anything that did
      // not rebind is EXCLUDED from every subsequent per-location step, and
      // reported back as `degraded` instead of masqueraded as success.
      const introduced = new Set<string>()
      const failed: string[] = []
      for (const transport of deps.router.enabled()) {
        try {
          await transport.introduce({ sessionName: displayName, objective, organizationId: organization })
          introduced.add(transport.source)
          // Record the org binding ONLY where the row actually rebound, and
          // only off-broker: the local broker is single-tenant and ignores
          // organizationId, so an org is meaningless there — and tracking one
          // would let an org switch mark LOCAL as changed and drop the user's
          // local topics. A location whose introduce threw keeps its previous
          // binding, so the next introduce still sees the change and migrates it.
          if (organization !== undefined && transport.source !== LOCAL_LOCATION) {
            deps.session.setOrganizationFor(transport.source, organization)
          }
        } catch {
          failed.push(transport.source)
        }
      }

      // A location the session holds membership at but which is NOT in
      // `router.enabled()` (it self-disabled earlier, or never attached) is
      // never even offered an introduce, so it lands in neither `introduced`
      // nor `failed`. Yet its feeds cannot be restored and its
      // old-name memberships cannot be left (`router.get` throws). We
      // genuinely cannot migrate it and the ghost persists there — so it is
      // degraded too. Reporting a bare success here would be a lie.
      for (const location of membershipLocations(deps)) {
        if (introduced.has(location) || failed.includes(location)) continue
        failed.push(location)
      }

      // Channel joins go per-location: each subscribed channel has its
      // own transport and the router picks the matching one by name. Skip
      // locations whose introduce did not rebind (see above).
      for (const ch of deps.context.getSubscribedChannels()) {
        if (!introduced.has(ch.location)) continue
        try {
          const transport = deps.router.get(ch.location)
          await transport.joinChannel({ sessionName: displayName, channel: ch.name })
        } catch {
          // Non-fatal.
        }
      }

      // Topics, unlike channels, do NOT survive an org change. A channel is
      // addressed by NAME, so re-joining it re-resolves (or creates) the
      // same-named channel inside the new org - well-defined and correct. A
      // topic is addressed by a Convex ID that belongs to the OLD org: it is
      // meaningless in the new one, and re-joining or re-subscribing it would
      // trip the backend's org assertion (a ConvexError, which
      // `registerSubscriptionFailure` counts - three of them disable the whole
      // transport). So a foreign-org topic is DROPPED - and reported, never
      // silently discarded.
      const droppedTopics: Array<{ topic: string; channel: string; location: ChannelLocation }> = []
      if (restoring) {
        for (const topic of deps.context.getJoinedTopics()) {
          if (!introduced.has(topic.location)) continue
          // Untouched and still subscribed ⇒ nothing to redo.
          if (!restoresAt(topic.location)) continue

          if (orgChangedLocations.has(topic.location)) {
            droppedTopics.push({ topic: topic.topicName, channel: topic.channel, location: topic.location })
            // Only the ActiveContext bookkeeping is ours to drop: the transport
            // discarded this topic's feed itself when its introduce rebound the
            // session into a different org (the topic id belongs to the old one).
            deps.context.leaveTopic(topic.threadTs)
            continue
          }

          // Same org — either renamed, or healing a feed the transport suspended.
          // Re-join, or the session stays evicted from its own topics. Strictly
          // after the channel loop: the broker rejects a topic join from a
          // session that isn't in the topic's channel, and the transport only
          // re-attaches a suspended feed once its join has SUCCEEDED. The
          // returned history is discarded rather than re-emitted as fresh
          // messages: we already have it.
          try {
            const transport = deps.router.get(topic.location)
            await transport.joinTopic({ sessionName: displayName, topicId: topic.threadTs })
          } catch {
            // Non-fatal.
          }
        }
      }

      // Truthfulness: ask the transports AGAIN, after the re-joins. Any location
      // still holding a suspended feed is still deaf — we must never hand back a
      // clean success while the session cannot hear.
      for (const location of deafLocations(deps)) {
        if (!failed.includes(location)) failed.push(location)
      }

      return JSON.stringify({
        name: displayName,
        ...(objective ? { objective } : {}),
        ...(failed.length > 0 ? { degraded: failed } : {}),
        ...(droppedTopics.length > 0 ? { droppedTopics } : {}),
      })
    }
    case 'whoami': {
      if (!deps.session.hasName()) {
        return JSON.stringify({ error: 'No identity set. Call introduce with a name.' })
      }
      const objective = deps.session.getObjective()
      const activeChannel = deps.context.getActiveChannelRef()
      const activeTopicName = deps.context.hasTopic() ? deps.context.getTopicName() : undefined
      const activeTopicChannel = deps.context.getTopicChannel()
      const activeTopicLocation = deps.context.getTopicLocation()
      const subscribedChannels = deps.context.getSubscribedChannels().map((c) => ({
        name: c.name,
        location: c.location,
        source: c.source,
      }))

      // Expose every transport's runtime state so the user sees
      // degradation on any location (not just "the first non-local")
      // without having to chase it through a silent stall. Bring dormant
      // token-bearing locations online first so a valid remote reports as
      // enabled rather than missing.
      await deps.ensureAttached?.()
      const locationStates = await buildLocationStates(deps.router, deps.diagnostics)

      return JSON.stringify({
        name: deps.session.displayName,
        ...(objective ? { objective } : {}),
        ...(activeChannel ? { activeChannel: { name: activeChannel.name, location: activeChannel.location } } : {}),
        ...(activeTopicName
          ? {
              activeTopic: {
                name: activeTopicName,
                ...(activeTopicChannel ? { channel: activeTopicChannel } : {}),
                ...(activeTopicLocation ? { location: activeTopicLocation } : {}),
              },
            }
          : {}),
        subscribedChannels,
        locations: locationStates,
      })
    }
    case 'authenticate': {
      const { location, force } = args as { location?: string; force?: boolean }
      return handleAuthenticate(deps, location, force === true)
    }
    default:
      throw new Error(`Unknown identity tool: ${name}`)
  }
}

/** Every location the session currently holds a membership at — the union of
 *  its subscribed channels and joined topics. This is the set the migration
 *  has to move; a location in here that the router cannot serve is a location
 *  we cannot migrate. */
function membershipLocations(deps: IdentityToolDeps): Set<string> {
  const locations = new Set<string>()
  for (const ch of deps.context.getSubscribedChannels()) locations.add(ch.location)
  for (const topic of deps.context.getJoinedTopics()) locations.add(topic.location)
  return locations
}

/**
 * Locations where the transport is holding a SUSPENDED feed — i.e. it has a
 * membership it cannot currently deliver on, so the session is deaf there.
 *
 * A feed is suspended when the identity or membership behind it went away and
 * the join that would restore it has not happened (or failed). That is exactly
 * the fingerprint of a half-failed migration, and detecting it is what lets a
 * plain same-name retry HEAL the session instead of silently confirming the
 * deafness.
 *
 * We ASK THE TRANSPORT, which owns its feeds. The tool used to keep a parallel
 * copy of this in a pair of `${location}::${key}` maps and peek at those — and
 * a case mismatch in exactly that key is what made a channel look permanently
 * un-subscribed (KAI-418). There is no parallel copy to drift any more.
 *
 * The local broker has no per-feed subscriptions (it delivers over one shared
 * SSE stream), so it exposes no registry and the type guard skips it — it can
 * never be reported deaf.
 */
function deafLocations(deps: IdentityToolDeps): Set<ChannelLocation> {
  const deaf = new Set<ChannelLocation>()
  for (const location of membershipLocations(deps)) {
    let transport: Transport
    try {
      transport = deps.router.get(location)
    } catch {
      // Not routable (degraded / unconfigured). Handled by the `failed`
      // accounting in `introduce`, not here.
      continue
    }
    if (!hasFeedRegistry(transport)) continue
    const suspended = transport.suspendedFeeds()
    if (suspended.topics.length > 0 || suspended.channels.length > 0) deaf.add(location)
  }
  return deaf
}

/**
 * Drop every membership the session holds under its PREVIOUS name, so the
 * name it is about to abandon doesn't stay behind as a ghost member.
 *
 * Topics go first, then channels. The local broker's `leaveChannel` already
 * sweeps that channel's topics, but leaving topics explicitly keeps the
 * remote side exact and makes the outcome independent of that ordering.
 *
 * Every call is best-effort: a transport that is degraded, unconfigured, or
 * transiently failing must not block the caller from taking on its new
 * identity - a stale membership is a lesser evil than a nameless session.
 */
async function leaveUnderPreviousName(
  deps: IdentityToolDeps,
  previousName: string,
  rebinds: (location: ChannelLocation) => boolean,
): Promise<void> {
  for (const topic of deps.context.getJoinedTopics()) {
    if (!rebinds(topic.location)) continue
    try {
      const transport = deps.router.get(topic.location)
      await transport.leaveTopic({ sessionName: previousName, topicId: topic.threadTs })
    } catch (err) {
      // Non-fatal, but observable: a failed leave here means `previousName`
      // stays behind as a ghost member of this topic - the exact bug this
      // migration exists to prevent - so leave a trace rather than swallow it.
      logMigrationWarning(`leaveTopic "${topic.threadTs}" as "${previousName}" (${topic.location})`, err)
    }
  }
  for (const ch of deps.context.getSubscribedChannels()) {
    if (!rebinds(ch.location)) continue
    try {
      const transport = deps.router.get(ch.location)
      await transport.leaveChannel({ sessionName: previousName, channel: ch.name })
    } catch (err) {
      // Non-fatal, but observable: see leaveTopic above.
      logMigrationWarning(`leaveChannel "${ch.name}" as "${previousName}" (${ch.location})`, err)
    }
  }
}

/** Surface a best-effort identity-migration failure on stderr. These paths
 *  deliberately never throw (a stale membership is a lesser evil than a
 *  nameless session), but a silent swallow hides the very ghost-membership
 *  outcome the migration exists to prevent - so it gets a trace. */
function logMigrationWarning(what: string, err: unknown): void {
  process.stderr.write(`[cccollab] identity migration: ${what} failed: ${err instanceof Error ? err.message : String(err)}\n`)
}

/**
 * Build the per-location status map for `whoami`. Every transport in
 * the router contributes an entry keyed by its source (location name),
 * including the reserved `"local"` location, so callers can tell at a
 * glance which transports are live and which have self-disabled.
 *
 * `degradation` is only set on transports that expose it (the remote
 * transport carries it for auth / function-not-found / repeated-failure
 * cases). The local transport has no degradation surface.
 *
 * `organization` is `"local"` for the local broker, the bound
 * organization name for a remote transport (via `getBoundOrganizationName`),
 * or omitted when a remote transport has no session yet.
 *
 * `diagnostics`, when provided, contributes an entry for every location
 * whose attach FAILED and which is therefore absent from the router
 * (KAI-368). Those surface as `{ enabled: false, degradation: <reason> }`.
 * A location that is live in the router takes precedence over a stale
 * diagnostics entry for the same name.
 */
async function buildLocationStates(
  router: TransportRouter,
  diagnostics?: AttachDiagnostics,
): Promise<Record<string, { enabled: boolean; degradation?: string; organization?: string }>> {
  const entries = await Promise.all(
    router.all().map(async (transport) => {
      const maybeDegraded = transport as Partial<RemoteTransport>
      const degradation = typeof maybeDegraded.degradation === 'string' ? maybeDegraded.degradation : null

      let organization: string | undefined
      if (transport.source === LOCAL_LOCATION) {
        organization = 'local'
      } else if (typeof maybeDegraded.getBoundOrganizationName === 'function') {
        organization = (await maybeDegraded.getBoundOrganizationName()) ?? undefined
      }

      const state: { enabled: boolean; degradation?: string; organization?: string } = {
        enabled: transport.enabled,
        ...(degradation ? { degradation } : {}),
        ...(organization ? { organization } : {}),
      }
      return [transport.source, state] as const
    }),
  )
  const states: Record<string, { enabled: boolean; degradation?: string; organization?: string }> =
    Object.fromEntries(entries)

  // Merge in failed-attach locations that never made it into the router.
  // A live router entry always wins over a diagnostics record for the
  // same name, so a location that recovered isn't shown as degraded.
  for (const failure of diagnostics?.entries() ?? []) {
    if (states[failure.location] !== undefined) continue
    states[failure.location] = { enabled: false, degradation: failure.reason }
  }

  return states
}

async function handleAuthenticate(
  deps: IdentityToolDeps,
  locationArg: string | undefined,
  force: boolean,
): Promise<string> {
  // Resolve the target location name:
  //   1. explicit arg -> must match a known non-local location
  //   2. else the single non-local location configured -> use it
  //   3. else the first enabled non-local transport -> use it
  //   4. else setup guidance
  const nonLocalLocations = (deps.locations ?? []).filter((l) => !l.isLocal)
  let targetName: string | undefined
  if (locationArg !== undefined && locationArg !== '') {
    const match = nonLocalLocations.find((l) => l.name === locationArg)
    if (!match) {
      const known = nonLocalLocations.map((l) => l.name).join(', ') || '(none)'
      return `No non-local location named "${locationArg}" is configured. Known non-local locations: ${known}.`
    }
    targetName = match.name
  } else if (nonLocalLocations.length === 1) {
    targetName = nonLocalLocations[0]!.name
  } else if (nonLocalLocations.length > 1) {
    const enabled = deps.router.all().find((t) => t.source !== LOCAL_LOCATION && t.enabled)
    if (enabled) targetName = enabled.source
  }

  if (!targetName) {
    return (
      'Remote mode is not configured.\n\n' +
      'Add a non-local location under `locations` in ~/.cccollab/config.json ' +
      'with `url`, `clerkIssuer`, and `clerkClientId`, then call this tool ' +
      'again. See docs/architecture/clerk-auth-setup.md for the Clerk ' +
      'dashboard values.'
    )
  }

  const locationInfo = nonLocalLocations.find((l) => l.name === targetName)
  const url = locationInfo?.url
  if (!url) {
    return `Location "${targetName}" has no URL. Add a \`url\` under \`locations.${targetName}\` in ~/.cccollab/config.json.`
  }

  // Bring a dormant-but-token-bearing location online first: if valid
  // tokens are already on disk, this attaches without a sign-in, and the
  // short-circuit below then reports "already authenticated" instead of
  // forcing a fresh OAuth round-trip. `force: true` here is an explicit
  // recovery attempt — it bypasses both the introduce gate (authenticate
  // does not require a prior introduce) and the once-per-session guard, so a
  // single earlier transient lazy-attach failure does not condemn the user
  // to a full browser sign-in despite valid tokens on disk.
  if (!force) await deps.ensureAttached?.(targetName, { force: true })

  // If we're not forcing a re-auth and a transport exists and is
  // enabled, short-circuit: tokens are already live.
  const existingTransport: Transport | undefined = deps.router.all().find((t) => t.source === targetName)
  if (!force && existingTransport?.enabled === true) {
    const asEmail = locationInfo?.userEmail ? ` (signed in as ${locationInfo.userEmail})` : ''
    return `Already authenticated to "${targetName}"${asEmail}. Pass force: true to re-authenticate.`
  }

  if (!locationInfo?.clerkIssuer || !locationInfo.clerkClientId) {
    return `Location "${targetName}" is missing \`clerkIssuer\` or \`clerkClientId\`. Add them under \`locations.${targetName}\` in ~/.cccollab/config.json or .cccollab.json — see docs/architecture/clerk-auth-setup.md.`
  }

  let authResult: { locationName: string; url: string; userEmail?: string }
  try {
    const tokens = await runClerkPkce({
      issuer: locationInfo.clerkIssuer,
      clientId: locationInfo.clerkClientId,
      redirectPort: locationInfo.clerkRedirectPort,
    })
    saveLocationAuth(targetName, {
      authType: 'clerk',
      url,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      // Persist the app-pointer that actually minted these tokens (the
      // guard above guarantees both are present) so a later session's
      // refresh uses the matching Clerk instance even if the issuer came
      // from a CCCOLLAB_CLERK_* env override absent at refresh time.
      clerkIssuer: locationInfo.clerkIssuer,
      clerkClientId: locationInfo.clerkClientId,
    })
    authResult = { locationName: targetName, url }
  } catch (err) {
    return `Authentication failed: ${err instanceof Error ? err.message : String(err)}`
  }

  // Tokens are persisted. Try to hot-attach; on failure keep the tokens
  // and fall back to the old "restart to activate" guidance so the user
  // still gets a working session next time. We never silently swallow
  // - the fallback message reports the underlying reason for debugging.
  const cwd = deps.cwd ?? process.cwd()
  const env = deps.env ?? process.env
  const messageBus = deps.messageBus
  if (!messageBus) {
    // The process-level wiring didn't thread in the MessageBus. Unit
    // tests that skip server.ts construction land here - report the
    // sign-in and rely on restart to pick up the persisted tokens.
    return `Signed in to "${authResult.locationName}". Restart your Claude Code session for the remote transport to take effect.`
  }

  const refreshed = resolveConfig(cwd, env)
  // Find the just-authenticated location in the fresh config. On the
  // first-ever sign-in against an env-only URL, this will be present
  // because `saveLocationAuth` wrote tokens under the named key and
  // `loadUserConfig` now sees them.
  const fresh = refreshed.locations.find((l) => l.name === authResult.locationName)
  if (!fresh || !fresh.url || !fresh.accessToken || !fresh.refreshToken) {
    return (
      `Signed in to "${authResult.locationName}" but could not locate the freshly-saved tokens ` +
      `in the resolved config. Restart your Claude Code session for the remote transport to take effect.`
    )
  }

  // Mirror the freshly-resolved non-local location into the deps'
  // in-memory snapshot so subsequent tool calls (list_channels,
  // authenticate with no location arg, etc) see the new name without
  // needing a restart. When the location was already in deps.locations,
  // replace the entry in place; otherwise append.
  if (deps.locations) {
    const idx = deps.locations.findIndex((l) => l.name === fresh.name)
    if (idx >= 0) deps.locations[idx] = fresh
    else deps.locations.push(fresh)
  }

  const ctx: AttachCtx = {
    session: deps.session,
    context: deps.context,
    router: deps.router,
    messageBus,
    // Fall back to a process-local map when the caller didn't thread
    // one through (older unit-test paths). attachLocation only iterates
    // this map on the replace-in-place prefix sweep, so a local map is
    // safe: its lifetime is bounded by the call, and no other code path
    // expects entries to persist across calls in that test scenario.
    resolved: {
      locations: refreshed.locations,
      activeLocation: refreshed.active.activeLocation,
      activeChannel: refreshed.active.activeChannel,
      activeTopic: refreshed.active.activeTopic,
    },
    transportFactory: deps.transportFactory,
    // Clear any prior startup/lazy attach failure for this location on a
    // successful hot-attach (and refresh the reason on a repeat failure)
    // so whoami stops showing a resolved "✗" after re-authentication.
    diagnostics: deps.diagnostics,
  }

  const result = await attachLocation(authResult.locationName, ctx)
  if (result.ok) {
    const who = fresh.userEmail ? ` as ${fresh.userEmail}` : ''
    return `Signed in${who}. Remote location "${authResult.locationName}" is now active.`
  }
  // Hot-attach failed after tokens were saved. Log the underlying
  // reason, keep the tokens on disk, and fall back to the old guidance.
  process.stderr.write(`[cccollab] Hot-attach failed for "${authResult.locationName}": ${result.reason}\n`)
  return (
    `Signed in to "${authResult.locationName}", but the remote transport could not attach to this running session ` +
    `(${result.reason}). Restart your Claude Code session for the remote transport to take effect.`
  )
}
