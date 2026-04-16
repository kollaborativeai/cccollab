import type { SessionManager } from '../session.js'

export interface IdentityToolDeps {
  session: SessionManager
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
  ]
}

export async function handleIdentityTool(
  name: string, args: Record<string, unknown>, deps: IdentityToolDeps
): Promise<string> {
  switch (name) {
    case 'introduce': {
      const { name: displayName, objective } = args as { name: string; objective?: string }
      deps.session.setName(displayName)
      return `Introduced as "${displayName}".${objective ? ` Objective: ${objective}` : ''}`
    }
    default:
      throw new Error(`Unknown identity tool: ${name}`)
  }
}
