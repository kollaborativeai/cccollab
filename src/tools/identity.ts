import type { SessionManager } from '../session.js'

export interface IdentityToolDeps {
  session: SessionManager
  brokerPort: number
}

export function createIdentityTools() {
  return [
    {
      name: 'introduce',
      description: 'Set your name and optionally your current objective. Required before any topic/messaging tool will work.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Your display name (e.g., "architect", "frontend", "reviewer")' },
          objective: { type: 'string' as const, description: 'What you are currently working on (optional)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'whoami',
      description: 'Show your current session identity (name and objective). Useful after context compaction or when a session was pre-seeded via env vars or .cccollab.json.',
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
      deps.session.setObjective(objective)
      await registerSession(deps.brokerPort, displayName, objective)
      return `Introduced as "${displayName}".${objective ? ` Objective: ${objective}` : ''}`
    }
    case 'whoami': {
      if (!deps.session.hasName()) {
        return 'This session has no identity set. Call `introduce` with a name to identify yourself.'
      }
      const objective = deps.session.getObjective()
      const lines = [`Name: ${deps.session.displayName}`]
      lines.push(`Objective: ${objective ?? '(not set)'}`)
      return lines.join('\n')
    }
    default:
      throw new Error(`Unknown identity tool: ${name}`)
  }
}

async function registerSession(brokerPort: number, name: string, objective?: string): Promise<void> {
  try {
    await fetch(`http://localhost:${brokerPort}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, objective }),
    })
  } catch {
    // Non-fatal - broker may not be up yet, session just won't appear in list_sessions
  }
}
