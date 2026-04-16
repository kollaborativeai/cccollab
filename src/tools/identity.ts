import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'

export interface IdentityToolDeps {
  session: SessionManager
  botClient: WebClient
  registryChannelId: string
}

const ANNOUNCE_PATTERN = /:robot_face: \*\[(.+?)\]\* online \| Role: (.+?)(?:\s*\|\s*Status: (.+))?$/
const STATUS_PATTERN = /:robot_face: \*\[(.+?)\]\* status \| (.+)$/

export function createIdentityTools() {
  return [
    {
      name: 'introduce',
      description: 'Set your name, role, and status. Posts to the session registry so other sessions can find you.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          role: { type: 'string' as const, description: 'Your role (e.g., frontend, backend, fullstack)' },
          status: { type: 'string' as const, description: 'Optional status message' },
          name_override: { type: 'string' as const, description: 'Override the auto-derived session name' },
        },
        required: ['role'],
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
      const { role, status, name_override } = args as { role: string; status?: string; name_override?: string }
      if (name_override) deps.session.overrideName(name_override)
      deps.session.setRole(role)
      let text = `:robot_face: *[${deps.session.sessionName}]* online | Role: ${role}`
      if (status) text += ` | Status: ${status}`
      await deps.botClient.chat.postMessage({ channel: deps.registryChannelId, text })
      return `Session "${deps.session.sessionName}" introduced with role "${role}"`
    }
    case 'who': {
      const result = await deps.botClient.conversations.history({ channel: deps.registryChannelId, limit: 100 })
      const sessions = new Map<string, { role: string; status: string; ts: string }>()
      for (const msg of (result.messages ?? []).reverse()) {
        const text = msg.text ?? ''
        const ts = msg.ts ?? ''
        const announceMatch = ANNOUNCE_PATTERN.exec(text)
        if (announceMatch) {
          const sessionName = announceMatch[1]!
          const existing = sessions.get(sessionName)
          if (!existing || ts > existing.ts) {
            sessions.set(sessionName, { role: announceMatch[2]!, status: announceMatch[3] ?? '', ts })
          }
          continue
        }
        const statusMatch = STATUS_PATTERN.exec(text)
        if (statusMatch) {
          const existing = sessions.get(statusMatch[1]!)
          if (existing && ts > existing.ts) {
            existing.status = statusMatch[2]!
            existing.ts = ts
          }
        }
      }
      if (sessions.size === 0) return 'No sessions currently registered.'
      const lines = ['Online sessions:']
      for (const [n, info] of sessions) {
        let line = `  - ${n} (${info.role})`
        if (info.status) line += ` - ${info.status}`
        lines.push(line)
      }
      return lines.join('\n')
    }
    default:
      throw new Error(`Unknown identity tool: ${name}`)
  }
}
