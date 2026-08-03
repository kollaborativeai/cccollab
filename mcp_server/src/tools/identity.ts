import type { ActiveContext } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import type { TransportRouter } from '../transport/router.js'
import { LOCAL_LOCATION, type Transport } from '../transport/index.js'
import type { RemoteTransport } from '../transport/remote.js'
import { runClerkPkce } from '../remote/auth-clerk.js'
import { saveLocationAuth } from '../config/save.js'
import { attachLocation, type AttachCtx } from '../transport/attach.js'
import type { AttachDiagnostics } from '../transport/diagnostics.js'
import { resolveConfig, type ResolvedLocation } from '../config/resolve.js'
import { driftWarning, type VersionState } from '../plugin-version.js'

export interface IdentityToolDeps {
  /** Result of the plugin/binary version handshake, computed once at startup.
   *  Optional so unit tests that do not exercise it can omit it. */
  versionState?: VersionState
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
  /** Health of the local broker's SSE stream — the only carrier of local topic
   *  traffic. `connected` answers "is a watch in effect RIGHT NOW";
   *  `mayHaveMissedMessages` answers the question a socket cannot: "is there a
   *  hole in what I heard?". Both are needed: an open socket says nothing about
   *  what was published while it was closed. Optional: absent means unknown,
   *  which reports as not-active (under-claiming is recoverable; over-claiming
   *  is the bug). */
  localEventStream?: () => { connected: boolean; mayHaveMissedMessages: boolean }
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

      deps.session.setName(displayName)
      deps.session.setObjective(objective)

      // Identity fans out: every enabled transport learns who we are so
      // it can attribute messages and list us in `list_sessions`. Each
      // introduce() is best-effort; a transient failure on one transport
      // must not prevent the other from registering.
      for (const transport of deps.router.enabled()) {
        try {
          await transport.introduce({ sessionName: displayName, objective, organizationId: organization })
        } catch {
          // Non-fatal: a subsequent introduce or tool call will
          // re-register.
        }
      }

      // Channel joins go per-location: each subscribed channel has its
      // own transport and the router picks the matching one by name.
      for (const ch of deps.context.getSubscribedChannels()) {
        try {
          const transport = deps.router.get(ch.location)
          await transport.joinChannel({ sessionName: displayName, channel: ch.name })
        } catch {
          // Non-fatal.
        }
      }

      // Drift is reported on `introduce` because it is the one tool every
      // session must call before any other, which makes it the only reliable
      // place to tell the model that the instructions it is following may not
      // describe this server. Attached to the result rather than logged: the
      // model reads results, and stderr goes to a file nobody opens mid-session.
      const versionWarning = deps.versionState ? driftWarning(deps.versionState) : undefined

      return JSON.stringify({
        name: displayName,
        ...(objective ? { objective } : {}),
        ...(versionWarning ? { warning: versionWarning } : {}),
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
      // `watching` is what the session ASKED for; `watchingActive` is whether
      // it is actually in effect. Local topic traffic only arrives over the SSE
      // stream, so a watcher with a disconnected listener is deaf — and a
      // `watching: true` that ignores that is exactly the confidently-blind
      // report KAI-414 exists to eliminate. Unknown liveness reads as NOT
      // active: under-claiming is recoverable, over-claiming is the bug.
      const stream = deps.localEventStream?.() ?? { connected: false, mayHaveMissedMessages: false }
      const localEventsLive = stream.connected
      const subscribedChannels = deps.context.getSubscribedChannels().map((c) => ({
        name: c.name,
        location: c.location,
        source: c.source,
        watching: c.watching,
        watchingActive: c.watching && c.location === LOCAL_LOCATION && localEventsLive,
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
        // Stream health, separate from any one channel: `connected` is "am I
        // hearing things now", `mayHaveMissedMessages` is "did I lose any while
        // I wasn't". A watch that can only answer the first is an unsound
        // oracle — see KAI-414.
        eventStream: { connected: stream.connected, mayHaveMissedMessages: stream.mayHaveMissedMessages },
        locations: locationStates,
        ...(deps.versionState
          ? {
              versions: {
                server: deps.versionState.serverVersion,
                ...(deps.versionState.pluginVersion ? { skill: deps.versionState.pluginVersion } : {}),
                status: deps.versionState.status,
              },
            }
          : {}),
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
