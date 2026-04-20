import type { ActiveContext } from '../context.js'
import type { SessionManager } from '../session.js'
import type { TransportRouter } from '../transport/router.js'
import { LOCAL_LOCATION, type Transport } from '../transport/index.js'
import type { RemoteTransport } from '../transport/remote.js'
import { runAuthenticate } from '../remote/auth.js'

export interface IdentityToolDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  /** Optional view of the resolved config used by `authenticate` to
   *  find a URL for a given location name. When omitted, `authenticate`
   *  falls back to reading the transport URL from the router. */
  locations?: Array<{ name: string; isLocal: boolean; url?: string }>
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
    return `Already authenticated to "${targetName}". Pass force: true to re-authenticate. (Restart your Claude Code session if needed.)`
  }

  try {
    const result = await runAuthenticate({ locationName: targetName, url })
    return `Signed in to "${result.locationName}". Restart your Claude Code session for the remote transport to take effect.`
  } catch (err) {
    return `Authentication failed: ${err instanceof Error ? err.message : String(err)}`
  }
}
