import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSessionTools, handleSessionTool, type SessionToolDeps } from '../../src/tools/session.js'
import { SessionManager } from '../../src/session.js'

function createMockDeps(): SessionToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    webClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '100.200' }) },
      conversations: {
        history: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { text: ':robot_face: *[carlos-backend]* online | Role: backend | Status: Working on API', ts: '100.100' },
            { text: ':robot_face: *[stefan-dispatcher]* online | Role: fullstack | Status: Starting up', ts: '100.050' },
            { text: ':robot_face: *[carlos-backend]* online | Role: backend | Status: Idle', ts: '99.999' },
          ],
        }),
      },
    } as never,
    registryChannelId: 'C_REGISTRY',
  }
}

describe('Session Tools', () => {
  describe('createSessionTools', () => {
    it('returns 3 tool definitions', () => {
      const tools = createSessionTools()
      expect(tools).toHaveLength(3)
      expect(tools.map((t) => t.name)).toEqual(['announce_session', 'list_sessions', 'set_status'])
    })
  })

  describe('handleSessionTool', () => {
    let deps: SessionToolDeps

    beforeEach(() => { deps = createMockDeps() })

    it('announce_session posts to registry channel', async () => {
      const result = await handleSessionTool('announce_session', { role: 'fullstack' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan-dispatcher]* online | Role: fullstack',
      })
      expect(result).toContain('stefan-dispatcher')
    })

    it('announce_session includes status when provided', async () => {
      await handleSessionTool('announce_session', { role: 'fullstack', status: 'Working on auth' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan-dispatcher]* online | Role: fullstack | Status: Working on auth',
      })
    })

    it('announce_session allows name override', async () => {
      await handleSessionTool('announce_session', { role: 'frontend', name_override: 'stefan-frontend' }, deps)
      expect(deps.session.sessionName).toBe('stefan-frontend')
    })

    it('list_sessions returns de-duplicated sessions', async () => {
      const result = await handleSessionTool('list_sessions', {}, deps)
      expect(result).toContain('carlos-backend')
      expect(result).toContain('Working on API')
      expect(result).not.toContain('Idle')
    })

    it('set_status posts updated status to registry', async () => {
      await handleSessionTool('set_status', { status: 'Reviewing PR #42' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan-dispatcher]* status | Reviewing PR #42',
      })
    })
  })
})
