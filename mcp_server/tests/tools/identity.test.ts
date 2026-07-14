import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'
import { LocalTransport } from '../../src/transport/local.js'
import { TransportRouter } from '../../src/transport/router.js'
import { ensureChannelSubscription, ensureLazyAttach, ensureTopicSubscription } from '../../src/transport/attach.js'
import { AttachDiagnostics } from '../../src/transport/diagnostics.js'
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

/** One recorded transport call, in the order the tool layer made it. */
interface RecordedCall {
  method: string
  args: Record<string, unknown>
}

/**
 * A Transport that records every call it receives, in order. The identity
 * transition (KAI-408) is fundamentally about ORDERING — the old name's
 * leaves must reach the wire before the new name's introduce — so these
 * tests assert on a single ordered call log rather than on per-method spies.
 */
function makeRecordingTransport(
  source: string,
  calls: RecordedCall[],
  overrides: Partial<Transport> = {},
): Transport {
  const record =
    <T>(method: string, result: T) =>
    async (args: Record<string, unknown>): Promise<T> => {
      calls.push({ method, args })
      return result
    }
  const transport = {
    source,
    enabled: true,
    hasTopic: () => true,
    introduce: record('introduce', undefined),
    joinChannel: record('joinChannel', { subscriberCount: 1 }),
    leaveChannel: record('leaveChannel', undefined),
    listChannels: record('listChannels', []),
    broadcast: record('broadcast', undefined),
    createTopic: record('createTopic', {
      id: 'uuid-1',
      topic: 'KAI-408',
      channel: 'kai',
      creator: 'bootstrap',
      state: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    listTopics: record('listTopics', []),
    getTopicById: record('getTopicById', null),
    joinTopic: record('joinTopic', { history: [] }),
    leaveTopic: record('leaveTopic', undefined),
    archiveTopic: record('archiveTopic', undefined),
    unarchiveTopic: record('unarchiveTopic', undefined),
    sendTopicMessage: record('sendTopicMessage', undefined),
    listSessions: record('listSessions', []),
    readChannelMessages: record('readChannelMessages', { messages: [], hasMore: false }),
    readTopicMessages: record('readTopicMessages', { messages: [], hasMore: false }),
    deregisterSession: record('deregisterSession', undefined),
    ...overrides,
  }
  return transport as unknown as Transport
}

function makeRecordingDeps(calls: RecordedCall[], overrides?: Partial<Transport>): IdentityToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    context: new ActiveContext(),
    router: new TransportRouter([makeRecordingTransport('local', calls, overrides)]),
  }
}

/**
 * A recording transport that also models the two things that make the
 * remote path different from the local broker:
 *
 *  - `introduce` REBINDS an internal session id (the Convex session row),
 *    which is what every subsequent call is addressed by, and
 *  - the reactive subscriptions FREEZE that id into their query args at
 *    subscribe time — so a subscription registered before a rename keeps
 *    querying as the old, now-membership-less session.
 *
 * `boundSessionId` on each recorded subscribe call is what lets the tests
 * assert the subscriptions were actually re-bound to the new identity.
 *
 * `introduceThrowsAfter` models RemoteTransport.introduce's real contract: it
 * only rebinds its session id AFTER the backend mutation resolves, and
 * RETHROWS on failure (leaving the id pointing at the pre-rename row). Set it
 * to N to have the (N+1)-th introduce throw without rebinding — e.g. 1 lets a
 * bootstrap introduce succeed and the rename introduce fail.
 */
function makeRecordingRemoteTransport(
  source: string,
  calls: RecordedCall[],
  opts?: { introduceThrowsAfter?: number },
): Transport {
  let sessionId: string | null = null
  let introduceCount = 0
  const base = makeRecordingTransport(source, calls)
  const remote = {
    ...base,
    introduce: async (args: Record<string, unknown>): Promise<void> => {
      introduceCount += 1
      calls.push({ method: 'introduce', args })
      if (opts?.introduceThrowsAfter !== undefined && introduceCount > opts.introduceThrowsAfter) {
        throw new Error(`introduce blip on ${source}`)
      }
      sessionId = `session_${String(args.sessionName)}`
    },
    primeTopicCursor: (topicId: string, ts: number): void => {
      calls.push({ method: 'primeTopicCursor', args: { topicId, ts } })
    },
    subscribeTopicMessages: (args: { topicId: string; channelName: string }): (() => void) => {
      calls.push({ method: 'subscribeTopicMessages', args: { ...args, boundSessionId: sessionId } })
      return () => calls.push({ method: 'unsubscribeTopic', args: { topicId: args.topicId } })
    },
    subscribeChannelMessages: (args: { channelName: string }): (() => void) => {
      calls.push({ method: 'subscribeChannelMessages', args: { ...args, boundSessionId: sessionId } })
      return () => calls.push({ method: 'unsubscribeChannel', args: { channelName: args.channelName } })
    },
  }
  return remote as unknown as Transport
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

    describe('introduce — identity transition on rename', () => {
      /**
       * A session's identity IS its name: the broker keys sessions,
       * channel membership and topic membership by name. A session boots
       * under the config's default name, auto-joins its channels/topics
       * under it, and only then does the agent introduce itself for real.
       * Without an explicit teardown the bootstrap name stays behind as a
       * ghost member of every channel and topic it joined.
       */
      async function bootstrapThenRename(
        calls: RecordedCall[],
        overrides?: Partial<Transport>,
      ): Promise<{ deps: IdentityToolDeps; result: string }> {
        const deps = makeRecordingDeps(calls, overrides)
        deps.context.joinChannel('kai', 'cccollab.json', 'local')
        await handleIdentityTool('introduce', { name: 'bootstrap' }, deps)
        deps.context.joinTopic('uuid-1', 'KAI-408', 'kai', 'local')
        calls.length = 0 // only the rename's wire traffic is under test
        const result = await handleIdentityTool('introduce', { name: 'kai-408' }, deps)
        return { deps, result }
      }

      it('leaves topics and channels as the OLD name, then introduces and re-joins as the NEW name', async () => {
        const calls: RecordedCall[] = []
        await bootstrapThenRename(calls)

        expect(calls.map((c) => [c.method, c.args.sessionName])).toEqual([
          ['leaveTopic', 'bootstrap'],
          ['leaveChannel', 'bootstrap'],
          ['introduce', 'kai-408'],
          ['joinChannel', 'kai-408'],
          ['joinTopic', 'kai-408'],
        ])
        expect(calls[0]!.args.topicId).toBe('uuid-1')
        expect(calls[1]!.args.channel).toBe('kai')
        expect(calls[3]!.args.channel).toBe('kai')
        expect(calls[4]!.args.topicId).toBe('uuid-1')
      })

      it('leaves under the old name BEFORE the introduce fan-out rebinds the remote session', async () => {
        // Load-bearing ordering: RemoteTransport ignores `sessionName` and
        // addresses the backend by its bound session row. Once introduce
        // rebinds that row to the new name, a leave can no longer reach the
        // old one — so the leaves must go out first.
        const calls: RecordedCall[] = []
        await bootstrapThenRename(calls)

        const introduceAt = calls.findIndex((c) => c.method === 'introduce')
        const leaveTopicAt = calls.findIndex((c) => c.method === 'leaveTopic')
        const leaveChannelAt = calls.findIndex((c) => c.method === 'leaveChannel')
        expect(leaveTopicAt).toBeGreaterThanOrEqual(0)
        expect(leaveChannelAt).toBeGreaterThanOrEqual(0)
        expect(leaveTopicAt).toBeLessThan(introduceAt)
        expect(leaveChannelAt).toBeLessThan(introduceAt)
      })

      it('re-joins channels before topics, since the broker gates topic join on channel membership', async () => {
        const calls: RecordedCall[] = []
        await bootstrapThenRename(calls)

        expect(calls.findIndex((c) => c.method === 'joinChannel')).toBeLessThan(
          calls.findIndex((c) => c.method === 'joinTopic'),
        )
      })

      it('leaves nothing on a first-ever introduce (there is no previous identity)', async () => {
        const calls: RecordedCall[] = []
        const deps = makeRecordingDeps(calls)
        deps.context.joinChannel('kai', 'cccollab.json', 'local')

        await handleIdentityTool('introduce', { name: 'kai-408' }, deps)

        expect(calls.filter((c) => c.method === 'leaveTopic' || c.method === 'leaveChannel')).toEqual([])
        expect(calls.map((c) => c.method)).toEqual(['introduce', 'joinChannel'])
      })

      it('does not churn leaves/re-joins when re-introducing under the SAME name', async () => {
        const calls: RecordedCall[] = []
        const deps = makeRecordingDeps(calls)
        deps.context.joinChannel('kai', 'cccollab.json', 'local')
        await handleIdentityTool('introduce', { name: 'kai-408' }, deps)
        deps.context.joinTopic('uuid-1', 'KAI-408', 'kai', 'local')
        calls.length = 0

        await handleIdentityTool('introduce', { name: 'kai-408', objective: 'fix the ghost member' }, deps)

        expect(calls.map((c) => c.method)).toEqual(['introduce', 'joinChannel'])
      })

      /**
       * Regression guard for the fix's own footgun. The backend gates both
       * reactive feeds on the subscribing session's membership rows
       * (listByTopic asserts channel presence; listByChannel returns [] with
       * no presence row), and a Convex `onUpdate` keeps the sessionId it was
       * registered with in its query args forever. So tearing down the old
       * name's memberships while its subscriptions are still live doesn't
       * just deafen the session — the topic query starts throwing, and three
       * of those in a minute disable the whole transport. The subscriptions
       * have to move to the new identity along with everything else.
       */
      describe('remote reactive subscriptions', () => {
        async function renameWithLiveSubscriptions(calls: RecordedCall[]): Promise<{
          deps: IdentityToolDeps
          topicMap: Map<string, () => void>
          channelMap: Map<string, () => void>
          result: string
        }> {
          const topicMap = new Map<string, () => void>()
          const channelMap = new Map<string, () => void>()
          const transport = makeRecordingRemoteTransport('remote', calls)
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
            remoteTopicUnsubscribes: topicMap,
            remoteChannelUnsubscribes: channelMap,
          }

          // Boot as the config's default name: join the channel, introduce,
          // join a topic, and auto-subscribe — exactly what attach.ts does
          // before the agent gets a chance to say who it really is.
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport, locationName: 'remote', channelName: 'kai', messageBus, map: channelMap })
          ensureTopicSubscription({
            transport,
            locationName: 'remote',
            topicId: 'topic_1',
            channelName: 'kai',
            messageBus,
            map: topicMap,
          })
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)
          return { deps, topicMap, channelMap, result }
        }

        it('unsubscribes the old subscriptions and re-subscribes bound to the NEW session id', async () => {
          const calls: RecordedCall[] = []
          const { topicMap, channelMap } = await renameWithLiveSubscriptions(calls)

          // The subscriptions registered under the bootstrap identity were
          // actually torn down (their unsubscribe fns ran)...
          expect(calls.filter((c) => c.method === 'unsubscribeTopic')).toHaveLength(1)
          expect(calls.filter((c) => c.method === 'unsubscribeChannel')).toHaveLength(1)

          // ...and fresh ones were registered, bound to the new session row.
          const topicSub = calls.filter((c) => c.method === 'subscribeTopicMessages')
          const channelSub = calls.filter((c) => c.method === 'subscribeChannelMessages')
          expect(topicSub).toHaveLength(1)
          expect(channelSub).toHaveLength(1)
          expect(topicSub[0]!.args).toMatchObject({ topicId: 'topic_1', boundSessionId: 'session_kai-408' })
          expect(channelSub[0]!.args).toMatchObject({ channelName: 'kai', boundSessionId: 'session_kai-408' })

          // The maps are left holding the NEW unsubscribe fns, so a later
          // leave_topic / leave_channel still tears the right thing down.
          expect([...topicMap.keys()]).toEqual(['remote::topic_1'])
          expect([...channelMap.keys()]).toEqual(['remote::kai'])
        })

        it('re-subscribes only after the introduce fan-out and the re-joins', async () => {
          const calls: RecordedCall[] = []
          await renameWithLiveSubscriptions(calls)

          const at = (method: string): number => calls.findIndex((c) => c.method === method)
          // Subscribe args freeze the sessionId ⇒ must follow introduce.
          expect(at('subscribeChannelMessages')).toBeGreaterThan(at('introduce'))
          expect(at('subscribeTopicMessages')).toBeGreaterThan(at('introduce'))
          // The queries are membership-gated ⇒ must follow the re-joins.
          expect(at('subscribeChannelMessages')).toBeGreaterThan(at('joinChannel'))
          expect(at('subscribeTopicMessages')).toBeGreaterThan(at('joinTopic'))
          // And the old ones must be gone before the leaves delete the rows
          // they are gated on.
          expect(at('unsubscribeTopic')).toBeLessThan(at('leaveTopic'))
          expect(at('unsubscribeChannel')).toBeLessThan(at('leaveChannel'))
        })

        it('does not re-prime the topic cursor (the transport keeps its own high-water marks)', async () => {
          // Passing a sinceTs here would be redundant at best: the transport
          // instance survives the rename, so each subscribe re-primes from
          // its own topicMaxTs / channelMaxTs.
          const calls: RecordedCall[] = []
          await renameWithLiveSubscriptions(calls)
          expect(calls.filter((c) => c.method === 'primeTopicCursor')).toEqual([])
        })

        it('skips re-subscription cleanly when the message bus and maps are absent', async () => {
          // Legacy deps (and unit tests) construct IdentityToolDeps without
          // the hot-attach plumbing. That must not crash the rename.
          const calls: RecordedCall[] = []
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([makeRecordingRemoteTransport('remote', calls)]),
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          expect(JSON.parse(result)).toEqual({ name: 'kai-408' })
          expect(calls.some((c) => c.method.startsWith('subscribe'))).toBe(false)
          expect(calls.map((c) => c.method)).toEqual([
            'leaveTopic',
            'leaveChannel',
            'introduce',
            'joinChannel',
            'joinTopic',
          ])
        })
      })

      /**
       * If a location's introduce throws mid-rename, its session id did NOT
       * rebind (RemoteTransport rebinds only after the mutation resolves and
       * rethrows on failure). The old membership rows were already torn down,
       * so running the re-join/resubscribe against that stale id would either
       * recreate the old-name ghost or throw-and-swallow into a stranded
       * session — while the tool still lied "success". The migration must
       * skip that location and say so.
       */
      describe('introduce failure mid-fan-out', () => {
        it('skips re-join and resubscribe for the failed location and reports it as degraded', async () => {
          const calls: RecordedCall[] = []
          const topicMap = new Map<string, () => void>()
          const channelMap = new Map<string, () => void>()
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          // Bootstrap introduce succeeds; the rename introduce throws.
          const transport = makeRecordingRemoteTransport('remote', calls, { introduceThrowsAfter: 1 })
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
            remoteTopicUnsubscribes: topicMap,
            remoteChannelUnsubscribes: channelMap,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport, locationName: 'remote', channelName: 'kai', messageBus, map: channelMap })
          ensureTopicSubscription({
            transport,
            locationName: 'remote',
            topicId: 'topic_1',
            channelName: 'kai',
            messageBus,
            map: topicMap,
          })
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          // The rename introduce threw ⇒ no join or (re)subscribe under the
          // stale id — that is what would resurrect the ghost.
          expect(calls.some((c) => c.method === 'joinChannel')).toBe(false)
          expect(calls.some((c) => c.method === 'joinTopic')).toBe(false)
          expect(calls.some((c) => c.method === 'subscribeChannelMessages')).toBe(false)
          expect(calls.some((c) => c.method === 'subscribeTopicMessages')).toBe(false)
          // ...and the result tells the truth rather than a bare success.
          expect(JSON.parse(result)).toEqual({ name: 'kai-408', degraded: ['remote'] })
        })

        it('omits degraded and behaves as before when every introduce succeeds', async () => {
          const calls: RecordedCall[] = []
          const transport = makeRecordingRemoteTransport('remote', calls)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus: { push: vi.fn(async () => {}) } as unknown as MessageBus,
            remoteTopicUnsubscribes: new Map(),
            remoteChannelUnsubscribes: new Map(),
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          const parsed = JSON.parse(result)
          expect(parsed).toEqual({ name: 'kai-408' })
          expect('degraded' in parsed).toBe(false)
          expect(calls.some((c) => c.method === 'joinChannel')).toBe(true)
          expect(calls.some((c) => c.method === 'joinTopic')).toBe(true)
        })
      })

      it('still introduces under the new name when the transport throws on leave/join', async () => {
        const calls: RecordedCall[] = []
        const { deps, result } = await bootstrapThenRename(calls, {
          leaveTopic: async () => {
            throw new Error('leaveTopic exploded')
          },
          leaveChannel: async () => {
            throw new Error('leaveChannel exploded')
          },
          joinTopic: async () => {
            throw new Error('joinTopic exploded')
          },
        })

        expect(JSON.parse(result)).toEqual({ name: 'kai-408' })
        expect(deps.session.displayName).toBe('kai-408')
        expect(calls.map((c) => c.method)).toEqual(['introduce', 'joinChannel'])
      })
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

      it('surfaces a failed-to-attach remote (not in the router) as disabled+degraded from diagnostics', async () => {
        // KAI-368: a remote whose introduce failed at startup is NOT in
        // the router (invariant: router holds only healthy transports).
        // whoami must still report it as ✗ degraded, sourced from the
        // separate diagnostics registry, so the user can see *why* it's
        // missing without the plugin having bricked.
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
        vi.stubGlobal('fetch', mockFetch)
        const diagnostics = new AttachDiagnostics()
        diagnostics.recordFailure('personal', 'introduce() failed for "personal": Server Error')
        deps.diagnostics = diagnostics

        await handleIdentityTool('introduce', { name: 'architect' }, deps)
        const result = JSON.parse(await handleIdentityTool('whoami', {}, deps))

        expect(result.locations.local).toEqual({ enabled: true, organization: 'local' })
        expect(result.locations.personal).toEqual({
          enabled: false,
          degradation: 'introduce() failed for "personal": Server Error',
        })
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
