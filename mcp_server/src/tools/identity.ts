import type { ActiveContext } from '../context.js'
import type { SessionManager } from '../session.js'
import type { TransportRouter } from '../transport/router.js'
import type { RemoteTransport } from '../transport/remote.js'
import { loadRemoteConfig } from '../remote/config.js'
import { runAuthenticate } from '../remote/auth.js'

export interface IdentityToolDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
}

export function createIdentityTools() {
  return [
    {
      name: 'introduce',
      description:
        'Set your name and optionally your current objective. Required before any topic/messaging tool will work. Registers your identity on every enabled transport. Returns JSON.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string' as const,
            description: 'Your display name (e.g., "architect", "frontend", "reviewer")',
          },
          objective: { type: 'string' as const, description: 'What you are currently working on (optional)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'whoami',
      description:
        'Return your session identity as JSON: {name, objective?, activeChannel?: {name, location}, activeTopic?: {name, channel, location}, subscribedChannels: [{name, location, source}], remote?: {configured, enabled, degradation?}}.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'authenticate',
      description:
        'Start or refresh the Google OAuth flow against a configured remote cccollab deployment. Writes tokens to ~/.cccollab/config.json and requires a Claude Code session restart to take effect for this session. Returns a human-readable confirmation or setup guidance if no CCCOLLAB_REMOTE_URL is set.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          force: {
            type: 'boolean' as const,
            description: 'Force a fresh sign-in even if a valid token is already persisted. Defaults to false.',
          },
        },
      },
    },
  ]
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
      // own transport and the router picks the matching one.
      for (const ch of deps.context.getSubscribedChannels()) {
        try {
          const transport = deps.router.getByLocation(ch.location)
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
      const { force } = args as { force?: boolean }
      return handleAuthenticate(deps, force === true)
    }
    default:
      throw new Error(`Unknown identity tool: ${name}`)
  }
}

function buildRemoteState(router: TransportRouter): Record<string, unknown> | null {
  if (!router.hasRemoteConfigured()) return null
  const remote = router.all().find((t) => t.source === 'remote') as RemoteTransport | undefined
  if (!remote) return { configured: false, enabled: false }
  return {
    configured: true,
    enabled: remote.enabled,
    ...(remote.degradation ? { degradation: remote.degradation } : {}),
  }
}

async function handleAuthenticate(deps: IdentityToolDeps, force: boolean): Promise<string> {
  // Resolve the remote URL from the canonical config (which already
  // reads CCCOLLAB_REMOTE_URL env var with backwards-compat for the
  // legacy CCCOLLAB_HOSTED_URL var, plus the persisted file).
  const cfg = loadRemoteConfig()
  const remoteUrl = cfg?.remoteUrl

  if (!remoteUrl) {
    return (
      'Remote mode is not configured.\n\n' +
      "Set CCCOLLAB_REMOTE_URL to your cccollab deployment's Convex URL " +
      '(e.g. https://wonderful-narwhal-409.convex.cloud) and call this ' +
      'tool again to sign in.'
    )
  }

  if (!force && cfg && cfg.accessToken !== '' && cfg.refreshToken !== '') {
    const who = cfg.userEmail ? ` as ${cfg.userEmail}` : ''
    return `Already authenticated${who}. Pass force: true to re-authenticate. (Restart your Claude Code session if the remote transport isn't active yet.)`
  }

  try {
    const result = await runAuthenticate({ remoteUrl })
    const who = result.userEmail ? ` as ${result.userEmail}` : ''
    void deps // deps unused in the happy path; kept to preserve the tool's handler shape
    return `Signed in${who}. Restart your Claude Code session for the remote transport to take effect.`
  } catch (err) {
    return `Authentication failed: ${err instanceof Error ? err.message : String(err)}`
  }
}
