import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'

export interface IdentityToolDeps {
  session: SessionManager
  botClient: WebClient
  registryChannelId: string
}

const ANNOUNCE_PATTERN = /:robot_face: \*\[(.+?)\]\* online(?:\s*\|\s*Objective: (.+))?$/
const OBJECTIVE_PATTERN = /:robot_face: \*\[(.+?)\]\* objective \| (.+)$/

export function createIdentityTools() {
  return [
    {
      name: 'introduce',
      description: 'Set your name and optionally your current objective. Posts to the session registry so other sessions can find you. If the user specifies a name, use it. If not, pick a short descriptive name based on what you are doing. Set the objective only if the user specifies one or you have a clear task.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Your display name (e.g., "architect", "frontend", "reviewer")' },
          objective: { type: 'string' as const, description: 'What you are currently working on (e.g., "reviewing auth module")' },
        },
        required: ['name'],
      },
    },
    {
      name: 'who',
      description: 'List online sessions from the registry.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ]
}

export async function handleIdentityTool(
  name: string, args: Record<string, unknown>, deps: IdentityToolDeps
): Promise<string> {
  switch (name) {
    case 'introduce': {
      const { name: displayName, objective } = args as { name: string; objective?: string }
      deps.session.setName(displayName)
      let text = `:robot_face: *[${deps.session.sessionName}]* online`
      if (objective) text += ` | Objective: ${objective}`
      await deps.botClient.chat.postMessage({ channel: deps.registryChannelId, text })
      return `Introduced as "${displayName}".${objective ? ` Objective: ${objective}` : ''}`
    }
    case 'who': {
      const result = await deps.botClient.conversations.history({ channel: deps.registryChannelId, limit: 100 })
      const cutoffTs = (Date.now() / 1000 - 4 * 3600).toString()
      const sessions = new Map<string, { objective: string; ts: string }>()
      for (const msg of (result.messages ?? []).reverse()) {
        const text = msg.text ?? ''
        const ts = msg.ts ?? ''
        if (ts < cutoffTs) continue
        const announceMatch = ANNOUNCE_PATTERN.exec(text)
        if (announceMatch) {
          const sessionName = announceMatch[1]!
          const existing = sessions.get(sessionName)
          if (!existing || ts > existing.ts) {
            sessions.set(sessionName, { objective: announceMatch[2] ?? '', ts })
          }
          continue
        }
        const objectiveMatch = OBJECTIVE_PATTERN.exec(text)
        if (objectiveMatch) {
          const existing = sessions.get(objectiveMatch[1]!)
          if (existing && ts > existing.ts) {
            existing.objective = objectiveMatch[2]!
            existing.ts = ts
          }
        }
      }
      if (sessions.size === 0) return 'No sessions currently registered.'
      const lines = ['Online sessions:']
      for (const [n, info] of sessions) {
        let line = `  - ${n}`
        if (info.objective) line += ` - ${info.objective}`
        lines.push(line)
      }
      return lines.join('\n')
    }
    default:
      throw new Error(`Unknown identity tool: ${name}`)
  }
}
