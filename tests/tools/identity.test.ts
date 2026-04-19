import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createIdentityTools, handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

function createMockDeps(): IdentityToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    context: new ActiveContext(),
    brokerPort: 7850,
  }
}

describe('Identity Tools', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  describe('createIdentityTools', () => {
    it('returns 2 tool definitions', () => {
      const tools = createIdentityTools()
      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.name)).toEqual(['introduce', 'whoami'])
    })
  })

  describe('handleIdentityTool', () => {
    let deps: IdentityToolDeps

    beforeEach(() => { deps = createMockDeps() })

    it('introduce sets display name on session', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      await handleIdentityTool('introduce', { name: 'architect' }, deps)
      expect(deps.session.displayName).toBe('architect')
    })

    it('introduce returns confirmation with name', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleIdentityTool('introduce', { name: 'architect' }, deps)
      expect(result).toContain('architect')
    })

    it('introduce includes objective in confirmation when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleIdentityTool('introduce', { name: 'architect', objective: 'reviewing auth module' }, deps)
      expect(result).toContain('reviewing auth module')
    })

    it('introduce re-registers already-subscribed channels with broker', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      await handleIdentityTool('introduce', { name: 'architect' }, deps)
      const channelJoinCall = mockFetch.mock.calls.find((c) => (c[0] as string).includes('/channels/join'))
      expect(channelJoinCall).toBeDefined()
      const body = JSON.parse((channelJoinCall![1]! as RequestInit).body as string)
      expect(body.channel).toBe('default')
      expect(body.sessionId).toBe('architect')
    })

    it('throws on unknown tool', async () => {
      await expect(handleIdentityTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown identity tool')
    })

    describe('whoami', () => {
      it('reports active channel and subscriptions with source', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
        deps.context.joinChannel('default', 'fallback')
        deps.context.joinChannel('project_x', 'manual')
        await handleIdentityTool('introduce', { name: 'architect', objective: 'design the API' }, deps)

        const result = await handleIdentityTool('whoami', {}, deps)
        expect(result).toContain('Name: architect')
        expect(result).toContain('Objective: design the API')
        expect(result).toContain('Active channel: #default')
        expect(result).toContain('#default')
        expect(result).toContain('fallback')
        expect(result).toContain('#project_x')
        expect(result).toContain('manual')
      })

      it('reports no active topic when none', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
        deps.context.joinChannel('default', 'fallback')
        await handleIdentityTool('introduce', { name: 'architect' }, deps)
        const result = await handleIdentityTool('whoami', {}, deps)
        expect(result).toContain('Active topic: (none)')
      })

      it('reports active topic with its channel', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
        deps.context.joinChannel('default', 'fallback')
        deps.context.joinTopic('uuid-1', 'Auth refactor', 'default')
        await handleIdentityTool('introduce', { name: 'architect' }, deps)
        const result = await handleIdentityTool('whoami', {}, deps)
        expect(result).toContain('Active topic: "Auth refactor"')
        expect(result).toContain('#default')
      })

      it('returns guidance when no name has been set', async () => {
        const result = await handleIdentityTool('whoami', {}, deps)
        expect(result).toContain('no identity set')
        expect(result).toContain('introduce')
      })
    })
  })
})
