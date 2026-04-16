import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'

export interface SessionToolDeps {
  session: SessionManager
  webClient: WebClient
  registryChannelId: string
}

const ANNOUNCE_PATTERN = /:robot_face: \*\[(.+?)\]\* online \| Role: (.+?)(?:\s*\|\s*Status: (.+))?$/
const STATUS_PATTERN = /:robot_face: \*\[(.+?)\]\* status \| (.+)$/

export function createSessionTools() {
  return [
    {
      name: 'announce_session',
      description: 'Register this session in the global registry so other sessions can discover you.',
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
      name: 'list_sessions',
      description: 'List all sessions currently registered in the global registry.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'set_status',
      description: "Update this session's status in the registry.",
      inputSchema: {
        type: 'object' as const,
        properties: { status: { type: 'string' as const, description: 'New status message' } },
        required: ['status'],
      },
    },
  ]
}

export async function handleSessionTool(
  name: string, args: Record<string, unknown>, deps: SessionToolDeps
): Promise<string> {
  switch (name) {
    case 'announce_session': {
      const { role, status, name_override } = args as { role: string; status?: string; name_override?: string }
      if (name_override) deps.session.overrideName(name_override)
      let text = `:robot_face: *[${deps.session.sessionName}]* online | Role: ${role}`
      if (status) text += ` | Status: ${status}`
      await deps.webClient.chat.postMessage({ channel: deps.registryChannelId, text })
      return `Session "${deps.session.sessionName}" announced with role "${role}"`
    }
    case 'list_sessions': {
      const result = await deps.webClient.conversations.history({ channel: deps.registryChannelId, limit: 100 })
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
      const lines = ['Active sessions:']
      for (const [n, info] of sessions) {
        let line = `  - ${n} (${info.role})`
        if (info.status) line += ` - ${info.status}`
        lines.push(line)
      }
      return lines.join('\n')
    }
    case 'set_status': {
      const { status } = args as { status: string }
      await deps.webClient.chat.postMessage({
        channel: deps.registryChannelId,
        text: `:robot_face: *[${deps.session.sessionName}]* status | ${status}`,
      })
      return `Status updated: ${status}`
    }
    default:
      throw new Error(`Unknown session tool: ${name}`)
  }
}
