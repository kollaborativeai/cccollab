import type { ActiveContext } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import type { TransportRouter } from '../transport/router.js'
import { LOCAL_LOCATION, type Transport } from '../transport/index.js'
import type { RemoteTransport } from '../transport/remote.js'
import { runAuthenticate } from '../remote/auth.js'
import { attachLocation, type AttachCtx } from '../transport/attach.js'
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
   *  the new transport's DM inbox subscription feeds inbound messages
   *  back into the session. Optional so existing unit tests that don't
   *  exercise the hot-attach path can continue to construct deps
   *  without a bus. */
  messageBus?: MessageBus
  /** Shared list of unsubscribe callbacks. The hot-attach path pushes
   *  the new transport's DM unsubscribe onto this array so `server.ts`'s
   *  shutdown hook runs it alongside the ones wired at startup. */
  remoteUnsubscribes?: Array<() => void>
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
}

export async function handleIdentityTool(
  name: string,
  args: Record<string, unknown>,
  deps: IdentityToolDeps,
): Promise<string> {
  switch (name) {
    case 'introduce': {
      const { name: displayName, objective } = args as { name: string; objective?: string }
      deps.session.setName(displayName)
      deps.session.setObjective(objective)

      // Identity fans out: every enabled transport learns who we are so
      // it can attribute messages and list us in `list_sessions`. Each
      // introduce() is best-effort; a transient failure on one transport
      // must not prevent the other from registering.
      for (const transport of deps.router.enabled()) {
        try {
          await transport.introduce({ sessionName: displayName, objective })
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

      return JSON.stringify({ name: displayName, ...(objective ? { objective } : {}) })
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

      // Expose remote-transport state so the user sees degradation
      // immediately rather than discovering it through a silent stall.
      const remoteState = buildRemoteState(deps.router)

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
        ...(remoteState ? { remote: remoteState } : {}),
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

function buildRemoteState(router: TransportRouter): Record<string, unknown> | null {
  if (!router.hasRemoteConfigured()) return null
  // Report the first non-local transport's state. In the multi-location
  // world a richer shape (per-location status map) makes sense; keep
  // the single-flag shape today so `whoami` stays readable.
  const remote = router.all().find((t) => t.source !== LOCAL_LOCATION) as RemoteTransport | undefined
  if (!remote) return { configured: false, enabled: false }
  return {
    configured: true,
    location: remote.source,
    enabled: remote.enabled,
    ...(remote.degradation ? { degradation: remote.degradation } : {}),
  }
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
      'Set CCCOLLAB_REMOTE_URL to a Convex deployment URL ' +
      '(e.g. https://wonderful-narwhal-409.convex.cloud) or add a location with a `url` ' +
      'under `locations` in ~/.cccollab/config.json, then call this tool again.'
    )
  }

  const locationInfo = nonLocalLocations.find((l) => l.name === targetName)
  const url = locationInfo?.url
  if (!url) {
    return `Location "${targetName}" has no URL. Add a \`url\` under \`locations.${targetName}\` in ~/.cccollab/config.json.`
  }

  // If we're not forcing a re-auth and a transport exists and is
  // enabled, short-circuit: tokens are already live.
  const existingTransport: Transport | undefined = deps.router.all().find((t) => t.source === targetName)
  if (!force && existingTransport?.enabled === true) {
    return `Already authenticated to "${targetName}". Pass force: true to re-authenticate.`
  }

  let authResult: { locationName: string; url: string; userEmail?: string }
  try {
    authResult = await runAuthenticate({ locationName: targetName, url })
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
  const remoteUnsubscribes = deps.remoteUnsubscribes
  if (!messageBus || !remoteUnsubscribes) {
    // The process-level wiring didn't thread in the MessageBus /
    // unsubscribe list. Unit tests that skip server.ts construction
    // land here - report the sign-in and rely on restart to pick up
    // the persisted tokens.
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
    cwd,
    env,
    session: deps.session,
    context: deps.context,
    router: deps.router,
    messageBus,
    remoteUnsubscribes,
    resolved: {
      locations: refreshed.locations,
      activeLocation: refreshed.active.activeLocation,
      activeChannel: refreshed.active.activeChannel,
      activeTopic: refreshed.active.activeTopic,
    },
    transportFactory: deps.transportFactory,
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
