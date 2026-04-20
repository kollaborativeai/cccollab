import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'
import { LocalTransport } from '../../src/transport/local.js'
import { TransportRouter } from '../../src/transport/router.js'

function createMockDeps(): IdentityToolDeps {
  const transport = new LocalTransport(7850)
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    context: new ActiveContext(),
    router: new TransportRouter([transport]),
  }
}

describe('Identity Tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('handleIdentityTool', () => {
    let deps: IdentityToolDeps

    beforeEach(() => {
      deps = createMockDeps()
    })

    it('introduce sets display name on session', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      await handleIdentityTool('introduce', { name: 'architect' }, deps)
      expect(deps.session.displayName).toBe('architect')
    })

    it('introduce returns JSON with name', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleIdentityTool('introduce', { name: 'architect' }, deps))
      expect(result).toEqual({ name: 'architect' })
    })

    it('introduce includes objective in JSON when provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(
        await handleIdentityTool('introduce', { name: 'architect', objective: 'reviewing auth module' }, deps),
      )
      expect(result).toEqual({ name: 'architect', objective: 'reviewing auth module' })
    })

    it('introduce re-registers already-subscribed channels with broker', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback', 'local')
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
      it('reports active channel with location and subscriptions with source+location', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
        deps.context.joinChannel('default', 'fallback', 'local')
        deps.context.joinChannel('project_x', 'manual', 'local')
        await handleIdentityTool('introduce', { name: 'architect', objective: 'design the API' }, deps)

        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
        expect(result.name).toBe('architect')
        expect(result.objective).toBe('design the API')
        expect(result.activeChannel).toEqual({ name: 'default', location: 'local' })
        expect(result.subscribedChannels).toEqual([
          { name: 'default', location: 'local', source: 'fallback' },
          { name: 'project_x', location: 'local', source: 'manual' },
        ])
      })

      it('omits activeTopic when none set', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
        deps.context.joinChannel('default', 'fallback', 'local')
        await handleIdentityTool('introduce', { name: 'architect' }, deps)
        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
        expect(result.activeTopic).toBeUndefined()
      })

      it('reports active topic with channel and location', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
        deps.context.joinChannel('default', 'fallback', 'local')
        deps.context.joinTopic('uuid-1', 'Auth refactor', 'default', 'local')
        await handleIdentityTool('introduce', { name: 'architect' }, deps)
        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
        expect(result.activeTopic).toEqual({ name: 'Auth refactor', channel: 'default', location: 'local' })
      })

      it('returns error JSON when no name has been set', async () => {
        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
        expect(result.error).toContain('introduce')
      })
    })

    describe('authenticate', () => {
      it('returns setup guidance when no non-local location is configured', async () => {
        // `deps` has no `locations` prop; authenticate should surface
        // setup guidance rather than spawning an OAuth flow against a
        // phantom URL.
        const result = await handleIdentityTool('authenticate', {}, deps)
        expect(result).toContain('Remote mode is not configured')
        expect(result).toContain('CCCOLLAB_REMOTE_URL')
      })
    })
  })
})
