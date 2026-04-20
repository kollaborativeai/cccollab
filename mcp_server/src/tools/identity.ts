import type { ActiveContext } from '../context.js'
import type { SessionManager } from '../session.js'
import type { Transport } from '../transport/index.js'

export interface IdentityToolDeps {
  session: SessionManager
  context: ActiveContext
  transport: Transport
}

export function createIdentityTools() {
  return [
    {
      name: 'introduce',
      description:
        'Set your name and optionally your current objective. Required before any topic/messaging tool will work. Returns JSON.',
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
        'Return your session identity as JSON: {name, objective?, activeChannel?, activeTopic?: {name, channel}, subscribedChannels: [{name, source}]}.',
      inputSchema: { type: 'object' as const, properties: {} },
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
      try {
        await deps.transport.introduce({ sessionName: displayName, objective })
      } catch {
        // Non-fatal: the transport may be transiently unreachable. A
        // subsequent introduce or tool call will rehydrate the session
        // registration server-side.
      }

      for (const ch of deps.context.getSubscribedChannels()) {
        try {
          await deps.transport.joinChannel({ sessionName: displayName, channel: ch.name })
        } catch {
          // Non-fatal: channel listing may be stale until re-introduce.
        }
      }

      return JSON.stringify({ name: displayName, ...(objective ? { objective } : {}) })
    }
    case 'whoami': {
      if (!deps.session.hasName()) {
        return JSON.stringify({ error: 'No identity set. Call introduce with a name.' })
      }
      const objective = deps.session.getObjective()
      const activeChannel = deps.context.getActiveChannel()
      const activeTopicName = deps.context.hasTopic() ? deps.context.getTopicName() : undefined
      const activeTopicChannel = deps.context.getTopicChannel()
      const subscribedChannels = deps.context.getSubscribedChannels().map((c) => ({ name: c.name, source: c.source }))

      return JSON.stringify({
        name: deps.session.displayName,
        ...(objective ? { objective } : {}),
        ...(activeChannel ? { activeChannel } : {}),
        ...(activeTopicName
          ? { activeTopic: { name: activeTopicName, ...(activeTopicChannel ? { channel: activeTopicChannel } : {}) } }
          : {}),
        subscribedChannels,
      })
    }
    default:
      throw new Error(`Unknown identity tool: ${name}`)
  }
}
