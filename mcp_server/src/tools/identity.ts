import type { ActiveContext } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import type { TransportRouter } from '../transport/router.js'
import { LOCAL_LOCATION, type Transport } from '../transport/index.js'
import type { RemoteTransport } from '../transport/remote.js'
import { runClerkPkce } from '../remote/auth-clerk.js'
import { saveLocationAuth } from '../config/save.js'
import {
  attachLocation,
  ensureChannelSubscription,
  ensureTopicSubscription,
  teardownChannelSubscription,
  teardownTopicSubscription,
  type AttachCtx,
} from '../transport/attach.js'
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
  /** Shared map of topic-message subscription unsubscribe callbacks,
   *  keyed by `${location}::${topicId}`. Threaded into `attachLocation`
   *  on the hot-attach path so auto-subscribe to configured topics wires
   *  reactive subscriptions there instead of on the next restart. */
  remoteTopicUnsubscribes?: Map<string, () => void>
  /** Shared map of channel-broadcast subscription unsubscribe callbacks,
   *  keyed by `${location}::${channelName}`. Mirrors
   *  `remoteTopicUnsubscribes` for channel-level broadcasts so bug B
   *  (channel messages not delivered to other remote subscribers) is
   *  covered by the same hot-attach wiring. */
  remoteChannelUnsubscribes?: Map<string, () => void>
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
      const subs = renamed ? remoteSubscriptionDeps(deps) : undefined

      // The (user, org, sessionName) backend key means an org change ALSO
      // rebinds the backend row, so a same-name re-introduce into a
      // different org orphans the old memberships exactly as an un-migrated
      // rename would. We can't distinguish a genuine org change from a
      // same-org id-vs-slug difference here - that resolution lives in the
      // backend (KAI-407) - so, given `organization` is compared as its raw
      // arg string, we fail SAFE: reject rather than half-migrate. Precise
      // handling that treats id and slug of the same org as unchanged is
      // deferred to a follow-up on the backend's resolved org id.
      const previousOrg = deps.session.getOrganization()
      const orgChanged = previousOrg !== undefined && organization !== undefined && previousOrg !== organization
      if (deps.session.hasName() && !renamed && orgChanged) {
        return JSON.stringify({
          error:
            'This session is already bound to a different organization. Re-introducing into another organization on a live session is not supported — start a new session (or re-introduce with a different name).',
        })
      }

      if (renamed) {
        // Drop the remote reactive subscriptions BEFORE the membership
        // rows they are gated on disappear. A live Convex `onUpdate` keeps
        // the sessionId it was registered with in its query args forever,
        // and the backend's listByTopic ASSERTS channel presence for that
        // id (ConvexError) while listByChannel returns []. Left running
        // across the leaves below, the topic subscription would therefore
        // start erroring - and `registerSubscriptionFailure` disables the
        // whole transport after three errors in a minute. No messages are
        // lost across this window: the transport keeps its own high-water
        // marks, so the re-subscription below re-requests everything with
        // a ts above what we last delivered.
        if (subs) teardownRemoteSubscriptions(deps, subs)

        // Ordering is load-bearing. RemoteTransport ignores `sessionName`
        // and addresses the backend by its bound session row, which the
        // introduce() fan-out below rebinds to the new name - so the old
        // row is only still reachable BEFORE that. LocalTransport keys
        // these calls by `sessionName`, so both transports drop exactly
        // the old identity's memberships. We deliberately do not delete
        // the old session itself: the bootstrap name is shared across the
        // user's concurrently-booting sessions.
        await leaveUnderPreviousName(deps, previousName)
      }

      deps.session.setName(displayName)
      deps.session.setObjective(objective)
      // Record the org so the NEXT re-introduce can detect a change against it.
      deps.session.setOrganization(organization)

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
        } catch {
          failed.push(transport.source)
        }
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

      if (renamed) {
        // Re-join under the new name what the teardown above dropped,
        // otherwise a rename silently evicts the session from its own
        // topics. Strictly after the channel loop: the broker rejects a
        // topic join from a session that isn't in the topic's channel.
        // The in-process `ActiveContext` bookkeeping is unchanged - only
        // the transports need to learn the new name - so the returned
        // history is discarded rather than re-emitted as fresh messages.
        // Same per-location gate: never re-join under a stale session id.
        for (const topic of deps.context.getJoinedTopics()) {
          if (!introduced.has(topic.location)) continue
          try {
            const transport = deps.router.get(topic.location)
            await transport.joinTopic({ sessionName: displayName, topicId: topic.threadTs })
          } catch {
            // Non-fatal.
          }
        }

        // Re-subscribe last: the reactive queries bind the transport's
        // CURRENT sessionId into their args, so they must be registered
        // after introduce() rebound it, and after the re-joins recreated
        // the membership rows those same queries are gated on.
        if (subs) resubscribeRemote(deps, subs, introduced)
      }

      return JSON.stringify({
        name: displayName,
        ...(objective ? { objective } : {}),
        ...(failed.length > 0 ? { degraded: failed } : {}),
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

/** The subset of deps needed to move the remote reactive subscriptions
 *  over to a new identity. All three are optional on `IdentityToolDeps`
 *  (the hot-attach path threads them; legacy unit tests don't), so this
 *  narrows them together or not at all. */
interface RemoteSubscriptionDeps {
  messageBus: MessageBus
  topicMap: Map<string, () => void>
  channelMap: Map<string, () => void>
}

function remoteSubscriptionDeps(deps: IdentityToolDeps): RemoteSubscriptionDeps | undefined {
  const { messageBus, remoteTopicUnsubscribes, remoteChannelUnsubscribes } = deps
  if (messageBus === undefined || remoteTopicUnsubscribes === undefined || remoteChannelUnsubscribes === undefined) {
    return undefined
  }
  return { messageBus, topicMap: remoteTopicUnsubscribes, channelMap: remoteChannelUnsubscribes }
}

/**
 * Drop the remote reactive subscriptions held under the outgoing identity.
 * A Convex `onUpdate` freezes the sessionId it was registered with into its
 * query args, so these MUST come down before the old identity's membership
 * rows do - the backend gates both feeds on exactly those rows.
 *
 * No-ops for the local broker: its topic/channel messages arrive over the
 * shared SSE stream, and `ensure*` / `teardown*` type-guard that away.
 */
function teardownRemoteSubscriptions(deps: IdentityToolDeps, subs: RemoteSubscriptionDeps): void {
  for (const topic of deps.context.getJoinedTopics()) {
    try {
      teardownTopicSubscription({ locationName: topic.location, topicId: topic.threadTs, map: subs.topicMap })
    } catch {
      // Non-fatal.
    }
  }
  for (const ch of deps.context.getSubscribedChannels()) {
    try {
      teardownChannelSubscription({ locationName: ch.location, channelName: ch.name, map: subs.channelMap })
    } catch {
      // Non-fatal.
    }
  }
}

/**
 * Re-register the remote reactive subscriptions so their query args carry
 * the NEW sessionId. Callable only after the introduce fan-out and the
 * re-joins: the args are bound at subscribe time and the queries are
 * membership-gated.
 *
 * Deliberately passes no `sinceTs`. The `RemoteTransport` instance outlives
 * the rename and keeps its own per-topic / per-channel high-water marks, so
 * each subscribe re-primes its own cursor and neither replays history nor
 * drops what arrived during the swap. That matters most on the channel feed:
 * the backend's fallback read cursor is keyed by session NAME, so the newly
 * named session has none, and a subscribe without an explicit `sinceTs`
 * would dump the channel's entire broadcast backlog into the agent.
 */
function resubscribeRemote(deps: IdentityToolDeps, subs: RemoteSubscriptionDeps, introduced: Set<string>): void {
  for (const ch of deps.context.getSubscribedChannels()) {
    // A subscription binds the transport's CURRENT session id; a location
    // whose introduce did not rebind would subscribe under the stale id and
    // immediately fail its membership gate, so skip it (see the fan-out).
    if (!introduced.has(ch.location)) continue
    try {
      ensureChannelSubscription({
        transport: deps.router.get(ch.location),
        locationName: ch.location,
        channelName: ch.name,
        messageBus: subs.messageBus,
        map: subs.channelMap,
      })
    } catch (err) {
      // Non-fatal, but observable: a throw here (e.g. a degraded location)
      // leaves the session deaf on this channel with nothing to retry it.
      logMigrationWarning(`re-subscribe channel "${ch.name}" (${ch.location})`, err)
    }
  }
  for (const topic of deps.context.getJoinedTopics()) {
    if (!introduced.has(topic.location)) continue
    try {
      ensureTopicSubscription({
        transport: deps.router.get(topic.location),
        locationName: topic.location,
        topicId: topic.threadTs,
        channelName: topic.channel,
        messageBus: subs.messageBus,
        map: subs.topicMap,
      })
    } catch (err) {
      // Non-fatal, but observable: see re-subscribe channel above.
      logMigrationWarning(`re-subscribe topic "${topic.threadTs}" (${topic.location})`, err)
    }
  }
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
async function leaveUnderPreviousName(deps: IdentityToolDeps, previousName: string): Promise<void> {
  for (const topic of deps.context.getJoinedTopics()) {
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
    remoteTopicUnsubscribes: deps.remoteTopicUnsubscribes ?? new Map<string, () => void>(),
    remoteChannelUnsubscribes: deps.remoteChannelUnsubscribes ?? new Map<string, () => void>(),
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
