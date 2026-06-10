import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'
import { LocalTransport } from '../../src/transport/local.js'
import { TransportRouter } from '../../src/transport/router.js'
import { ensureLazyAttach } from '../../src/transport/attach.js'
import type { MessageBus } from '../../src/message-bus.js'
import type { Transport } from '../../src/transport/index.js'
import type { ResolvedLocation } from '../../src/config/resolve.js'

// Mock runClerkPkce so tests for the Clerk branch don't open a browser
// or start a loopback listener.
vi.mock('../../src/remote/auth-clerk.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/remote/auth-clerk.js')>(
    '../../src/remote/auth-clerk.js',
  )
  return {
    ...actual,
    runClerkPkce: vi.fn(async () => ({
      accessToken: 'clerk-access-token',
      refreshToken: 'clerk-refresh-token',
      idToken: 'clerk-id-token',
      accessTokenExpiresAt: 9999999999000,
    })),
  }
})

// Mock saveLocationAuth so the Clerk branch can be tested without
// touching ~/.cccollab/config.json or needing HOME redirection.
vi.mock('../../src/config/save.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/save.js')>('../../src/config/save.js')
  return {
    ...actual,
    saveLocationAuth: vi.fn(() => {}),
  }
})

function createMockDeps(): IdentityToolDeps {
  const transport = new LocalTransport(7850)
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    context: new ActiveContext(),
    router: new TransportRouter([transport]),
  }
}

/**
 * Builds deps whose router contains both the local transport and an enabled
 * fake remote transport. The remote transport's `introduce` records every
 * call it receives (and forwards them to `onIntroduce` when provided).
 * Optional `remoteOverrides` can be used to add extra methods to the fake
 * remote transport (e.g. `getBoundOrganizationName` for the whoami tests).
 */
function makeDepsWithRemote(
  onIntroduce?: (args: Record<string, unknown>) => void,
  remoteOverrides?: Partial<{ getBoundOrganizationName: () => Promise<string | null> }>,
): IdentityToolDeps {
  const localTransport = new LocalTransport(7850)
  const fakeRemote = {
    source: 'remote' as const,
    enabled: true,
    introduce: vi.fn(async (args: Record<string, unknown>) => {
      if (onIntroduce) onIntroduce(args)
    }),
    joinChannel: vi.fn(async () => {}),
    deregisterSession: vi.fn(async () => {}),
    leaveChannel: vi.fn(async () => {}),
    listChannels: vi.fn(async () => []),
    listTopics: vi.fn(async () => []),
    createTopic: vi.fn(async () => ({ id: 'topic_1', topic: 'test', channel: 'default' })),
    joinTopic: vi.fn(async () => ({ id: 'topic_1', topic: 'test', channel: 'default', history: [] })),
    leaveTopic: vi.fn(async () => {}),
    archiveTopic: vi.fn(async () => {}),
    unarchiveTopic: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    sendMessage: vi.fn(async () => {}),
    hasTopic: vi.fn(() => false),
    ...remoteOverrides,
  }
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    context: new ActiveContext(),
    router: new TransportRouter([
      localTransport,
      fakeRemote as unknown as import('../../src/transport/index.js').Transport,
    ]),
  }
}

/**
 * Builds deps whose router contains only the local transport (no remote).
 */
function makeLocalOnlyDeps(): IdentityToolDeps {
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

      it('includes the locations map with the local transport enabled by default', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
        await handleIdentityTool('introduce', { name: 'architect' }, deps)
        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
        expect(result.locations).toEqual({ local: { enabled: true, organization: 'local' } })
      })
    })

    describe('introduce — organization argument', () => {
      beforeEach(() => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
      })

      afterEach(() => {
        vi.unstubAllGlobals()
      })

      it('rejects introduce without an organization when a remote transport is enabled', async () => {
        const deps = makeDepsWithRemote() // router with an enabled remote transport
        const result = JSON.parse(await handleIdentityTool('introduce', { name: 'reviewer' }, deps))
        expect(result.error).toMatch(/organization/i)
      })

      it('forwards the organization to the remote transport introduce', async () => {
        const introduceCalls: Array<Record<string, unknown>> = []
        const deps = makeDepsWithRemote((args) => introduceCalls.push(args))
        await handleIdentityTool('introduce', { name: 'reviewer', organization: 'org_a' }, deps)
        expect(introduceCalls.some((c) => c.organizationId === 'org_a')).toBe(true)
      })

      it('allows introduce without an organization when only the local transport is present', async () => {
        const deps = makeLocalOnlyDeps()
        const result = JSON.parse(await handleIdentityTool('introduce', { name: 'reviewer' }, deps))
        expect(result.name).toBe('reviewer')
      })
    })

    describe('whoami — organization', () => {
      beforeEach(() => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
      })

      afterEach(() => {
        vi.unstubAllGlobals()
      })

      it('reports "local" for the local location', async () => {
        const deps = makeLocalOnlyDeps()
        await handleIdentityTool('introduce', { name: 'reviewer' }, deps)
        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
        expect(result.locations.local.organization).toBe('local')
      })

      it('reports the bound organization name for a remote location', async () => {
        const deps = makeDepsWithRemote(undefined, {
          getBoundOrganizationName: async () => 'Acme',
        })
        await handleIdentityTool('introduce', { name: 'reviewer', organization: 'org_a' }, deps)
        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
        expect(result.locations.remote.organization).toBe('Acme')
      })

      it('omits organization when the remote location has no bound org yet', async () => {
        const deps = makeDepsWithRemote(undefined, {
          getBoundOrganizationName: async () => null,
        })
        await handleIdentityTool('introduce', { name: 'reviewer', organization: 'org_a' }, deps)
        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))
        expect(result.locations.remote).toBeDefined()
        expect(result.locations.remote.organization).toBeUndefined()
        expect('organization' in result.locations.remote).toBe(false)
      })
    })

    describe('authenticate', () => {
      it('returns setup guidance when no non-local location is configured', async () => {
        // `deps` has no `locations` prop; authenticate should surface
        // setup guidance rather than spawning an OAuth flow against a
        // phantom URL.
        const result = await handleIdentityTool('authenticate', {}, deps)
        expect(result).toContain('Remote mode is not configured')
        expect(result).toContain('clerkIssuer')
        expect(result).toContain('clerkClientId')
      })

      it('short-circuits with the signed-in email when the location is already authenticated and userEmail is known', async () => {
        const { RemoteTransport } = await import('../../src/transport/remote.js')
        const stubClient = {
          query: vi.fn(async () => undefined),
          mutation: vi.fn(async () => undefined),
          onUpdate: vi.fn(() => () => {}),
          setAuth: vi.fn(),
          close: vi.fn(async () => {}),
        }
        const transport = new RemoteTransport({
          client: stubClient as unknown as import('convex/browser').ConvexClient,
          source: 'flatout',
          log: () => {},
        })
        const customDeps: IdentityToolDeps = {
          ...deps,
          router: new TransportRouter([transport]),
          locations: [
            {
              name: 'flatout',
              isLocal: false,
              url: 'https://example.convex.cloud',
              accessToken: 'a',
              refreshToken: 'r',
              userEmail: 'stefan@flatout.solutions',
              channels: [],
            },
          ],
        }
        const result = await handleIdentityTool('authenticate', { location: 'flatout' }, customDeps)
        expect(result).toContain('Already authenticated to "flatout"')
        expect(result).toContain('(signed in as stefan@flatout.solutions)')
        expect(result).toContain('Pass force: true to re-authenticate.')
      })

      it('short-circuits without an email suffix when userEmail is not known for the location', async () => {
        const { RemoteTransport } = await import('../../src/transport/remote.js')
        const stubClient = {
          query: vi.fn(async () => undefined),
          mutation: vi.fn(async () => undefined),
          onUpdate: vi.fn(() => () => {}),
          setAuth: vi.fn(),
          close: vi.fn(async () => {}),
        }
        const transport = new RemoteTransport({
          client: stubClient as unknown as import('convex/browser').ConvexClient,
          source: 'flatout',
          log: () => {},
        })
        const customDeps: IdentityToolDeps = {
          ...deps,
          router: new TransportRouter([transport]),
          locations: [
            {
              name: 'flatout',
              isLocal: false,
              url: 'https://example.convex.cloud',
              accessToken: 'a',
              refreshToken: 'r',
              channels: [],
            },
          ],
        }
        const result = await handleIdentityTool('authenticate', { location: 'flatout' }, customDeps)
        expect(result).toBe('Already authenticated to "flatout". Pass force: true to re-authenticate.')
      })

      it('lazily attaches a dormant token-bearing location and short-circuits without a fresh sign-in', async () => {
        // The reported regression: a remote with valid tokens on disk that
        // startup gating left dormant (not active, no channels) was never in
        // the router, so authenticate fell through to a full OAuth round-trip.
        // With lazy attach, authenticate brings it online from the stored
        // tokens and reports "already authenticated".
        const { runClerkPkce } = await import('../../src/remote/auth-clerk.js')
        ;(runClerkPkce as ReturnType<typeof vi.fn>).mockClear()

        const dormant: ResolvedLocation = {
          name: 'flatout',
          isLocal: false,
          url: 'https://example.convex.cloud',
          accessToken: 'a',
          refreshToken: 'r',
          idToken: 'i',
          clerkIssuer: 'https://x.clerk.accounts.dev',
          clerkClientId: 'cid',
          userEmail: 'stefan@flatout.solutions',
          channels: [],
        }
        const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
        session.setName('architect')
        const context = new ActiveContext()
        const router = new TransportRouter([new LocalTransport(7850)])
        const bus = { push: vi.fn(async () => {}) } as unknown as MessageBus
        const fakeRemote = {
          source: 'flatout',
          enabled: true,
          introduce: vi.fn(async () => {}),
        } as unknown as Transport

        const ensureAttached = (target?: string): Promise<void> =>
          ensureLazyAttach(target, {
            session,
            context,
            router,
            messageBus: bus,
            remoteTopicUnsubscribes: new Map(),
            remoteChannelUnsubscribes: new Map(),
            inflight: new Map<string, Promise<void>>(),
            candidates: ['flatout'],
            resolve: () => ({
              locations: [dormant],
              activeLocation: undefined,
              activeChannel: undefined,
              activeTopic: undefined,
            }),
            transportFactory: () => fakeRemote,
          })

        const customDeps: IdentityToolDeps = {
          session,
          context,
          router,
          locations: [dormant],
          ensureAttached,
        }

        const result = await handleIdentityTool('authenticate', { location: 'flatout' }, customDeps)

        expect(runClerkPkce).not.toHaveBeenCalled()
        expect(router.has('flatout')).toBe(true)
        expect(result).toContain('Already authenticated to "flatout"')
        expect(result).toContain('(signed in as stefan@flatout.solutions)')
      })

      it('authenticate dispatches to runClerkPkce when location.authType === "clerk"', async () => {
        const { runClerkPkce } = await import('../../src/remote/auth-clerk.js')
        const { saveLocationAuth } = await import('../../src/config/save.js')
        ;(runClerkPkce as ReturnType<typeof vi.fn>).mockClear()
        ;(saveLocationAuth as ReturnType<typeof vi.fn>).mockClear()

        const clerkDeps: IdentityToolDeps = {
          ...deps,
          locations: [
            {
              name: 'kai',
              isLocal: false,
              url: 'https://kai.convex.cloud',
              authType: 'clerk',
              clerkIssuer: 'https://x.clerk.accounts.dev',
              clerkClientId: 'cccollab-cli',
              channels: [],
            },
          ],
        }
        const result = await handleIdentityTool('authenticate', { location: 'kai' }, clerkDeps)

        // runClerkPkce must have been called with the correct issuer + clientId
        expect(runClerkPkce).toHaveBeenCalledWith({
          issuer: 'https://x.clerk.accounts.dev',
          clientId: 'cccollab-cli',
          redirectPort: undefined,
        })

        // saveLocationAuth must persist the clerk tokens — including the ID
        // token used for Convex auth — AND the clerkIssuer/clerkClientId that
        // minted them, so a later session (without the CCCOLLAB_CLERK_* env
        // override that may have supplied the issuer at auth time) refreshes
        // against the same Clerk instance the refresh token belongs to.
        expect(saveLocationAuth).toHaveBeenCalledWith('kai', {
          authType: 'clerk',
          url: 'https://kai.convex.cloud',
          accessToken: 'clerk-access-token',
          refreshToken: 'clerk-refresh-token',
          idToken: 'clerk-id-token',
          accessTokenExpiresAt: 9999999999000,
          clerkIssuer: 'https://x.clerk.accounts.dev',
          clerkClientId: 'cccollab-cli',
        })

        // The response should reference the location name (hot-attach
        // falls back gracefully without a messageBus in deps)
        expect(result).toContain('kai')
      })

      it('authenticate errors clearly when clerk location is missing clerkIssuer or clerkClientId', async () => {
        const clerkDeps: IdentityToolDeps = {
          ...deps,
          locations: [
            {
              name: 'kai',
              isLocal: false,
              url: 'https://kai.convex.cloud',
              authType: 'clerk',
              // clerkIssuer intentionally omitted
              clerkClientId: 'cccollab-cli',
              channels: [],
            },
          ],
        }
        const result = await handleIdentityTool('authenticate', { location: 'kai' }, clerkDeps)
        expect(result).toContain('clerkIssuer')
        expect(result).toContain('clerkClientId')
      })
    })
  })
})
