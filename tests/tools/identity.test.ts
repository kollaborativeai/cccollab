import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIdentityTools, handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'

function createMockDeps(): IdentityToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    botClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '100.200' }) },
      conversations: {
        history: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { text: ':robot_face: *[carlos | api | reviewer]* objective | Working on API', ts: '100.200' },
            { text: ':robot_face: *[carlos | api | reviewer]* online | Objective: Idle', ts: '100.100' },
            { text: ':robot_face: *[stefan | dispatcher | architect]* online', ts: '100.050' },
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

    it('introduce posts to registry with name', async () => {
      const result = await handleIdentityTool('introduce', { name: 'architect' }, deps)
      expect(deps.botClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan | dispatcher | architect]* online',
      })
      expect(result).toContain('architect')
    })

    it('introduce includes objective when provided', async () => {
      await handleIdentityTool('introduce', { name: 'architect', objective: 'reviewing auth module' }, deps)
      expect(deps.botClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan | dispatcher | architect]* online | Objective: reviewing auth module',
      })
    })

    it('introduce sets display name on session', async () => {
      await handleIdentityTool('introduce', { name: 'frontend' }, deps)
      expect(deps.session.displayName).toBe('frontend')
    })

    it('who returns sessions with latest objective', async () => {
      const result = await handleIdentityTool('who', {}, deps)
      expect(result).toContain('carlos | api | reviewer')
      expect(result).toContain('Working on API')
    })

    it('who returns message when no sessions', async () => {
      ;(deps.botClient.conversations.history as ReturnType<typeof vi.fn>).mockResolvedValue({
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
