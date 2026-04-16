import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIdentityTools, handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'

function createMockDeps(): IdentityToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    webClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '100.200' }) },
      conversations: {
        history: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { text: ':robot_face: *[carlos-backend]* status | Working on API', ts: '100.200' },
            { text: ':robot_face: *[carlos-backend]* online | Role: backend | Status: Idle', ts: '100.100' },
            { text: ':robot_face: *[stefan | dispatcher | fullstack]* online | Role: fullstack', ts: '100.050' },
          ],
        }),
      },
    } as never,
    registryChannelId: 'C_REGISTRY',
  }
}

describe('Identity Tools', () => {
  describe('createIdentityTools', () => {
    it('returns 2 tool definitions', () => {
      const tools = createIdentityTools()
      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.name)).toEqual(['introduce', 'who'])
    })
  })

  describe('handleIdentityTool', () => {
    let deps: IdentityToolDeps

    beforeEach(() => { deps = createMockDeps() })

    it('introduce posts to registry channel with role', async () => {
      const result = await handleIdentityTool('introduce', { role: 'fullstack' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan | dispatcher | fullstack]* online | Role: fullstack',
      })
      expect(result).toContain('stefan | dispatcher | fullstack')
    })

    it('introduce includes status when provided', async () => {
      await handleIdentityTool('introduce', { role: 'fullstack', status: 'Working on auth' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan | dispatcher | fullstack]* online | Role: fullstack | Status: Working on auth',
      })
    })

    it('introduce allows name override', async () => {
      await handleIdentityTool('introduce', { role: 'frontend', name_override: 'stefan-frontend' }, deps)
      expect(deps.session.sessionName).toBe('stefan | stefan-frontend | frontend')
    })

    it('introduce calls setRole on session', async () => {
      await handleIdentityTool('introduce', { role: 'backend' }, deps)
      expect(deps.session.sessionName).toContain('backend')
    })

    it('who returns de-duplicated sessions with latest status', async () => {
      const result = await handleIdentityTool('who', {}, deps)
      expect(result).toContain('carlos-backend')
      expect(result).toContain('Working on API')
      expect(result).not.toContain('Idle')
    })

    it('who returns message when no sessions', async () => {
      ;(deps.webClient.conversations.history as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true, messages: [],
      })
      const result = await handleIdentityTool('who', {}, deps)
      expect(result).toBe('No sessions currently registered.')
    })

    it('throws on unknown tool', async () => {
      await expect(handleIdentityTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown identity tool')
    })
  })
})
