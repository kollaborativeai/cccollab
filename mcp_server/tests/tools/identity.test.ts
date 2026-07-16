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

/** One recorded transport call, in the order the tool layer made it.
 *  Subscription records additionally carry `deliver`, which routes a message
 *  through the tool-supplied `onEvent` iff the subscription is still live —
 *  so a test can prove that a re-subscribed feed actually DELIVERS and that a
 *  torn-down one is dead. */
interface RecordedCall {
  method: string
  args: Record<string, unknown>
  deliver?: (msg: Record<string, unknown>) => void
}

/**
 * A Transport that records every call it receives, in order. The identity
 * transition (KAI-408) is fundamentally about ORDERING — the old name's
 * leaves must reach the wire before the new name's introduce — so these
 * tests assert on a single ordered call log rather than on per-method spies.
 */
function makeRecordingTransport(source: string, calls: RecordedCall[], overrides: Partial<Transport> = {}): Transport {
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
 * A recording transport that honours RemoteTransport's real ownership contract
 * (KAI-418), because the tool layer's behaviour is only meaningful against a
 * transport that behaves like the real one:
 *
 *  - `introduce` REBINDS an internal session id (the Convex session row) and,
 *    when that id moves, SUSPENDS every live feed — their query args froze the
 *    old id. It only rebinds AFTER the backend call succeeds, and RETHROWS on
 *    failure, leaving the id pointing at the pre-rename row.
 *  - An `introduce` that changes ORG DISCARDS the topic feeds outright: their
 *    topic ids belong to the old org.
 *  - `joinChannel` / `joinTopic` RESTORE a suspended feed, under the id that is
 *    current at that moment.
 *  - `leaveChannel` / `leaveTopic` SUSPEND (the migration re-joins); only the
 *    deliberate `forget*Feed` removes a feed for good.
 *  - `suspendedFeeds()` reports exactly where the session is deaf.
 *
 * `boundSessionId` on each recorded subscribe records which identity a feed was
 * (re-)registered under; `deliver` fans a message through the ORIGINAL onEvent
 * iff the feed is currently live.
 *
 * `introduceThrowsAfter` / `introduceThrowsOnCall` make a chosen introduce fail.
 */
interface FakeFeed {
  channelName: string
  onEvent: (msg: Record<string, unknown>) => void
  live: boolean
}

function makeRecordingRemoteTransport(
  source: string,
  calls: RecordedCall[],
  opts?: { introduceThrowsAfter?: number; introduceThrowsOnCall?: number },
): Transport {
  let sessionId: string | null = null
  let boundOrg: string | undefined
  let introduceCount = 0
  const topicFeeds = new Map<string, FakeFeed>()
  const channelFeeds = new Map<string, FakeFeed>()
  const base = makeRecordingTransport(source, calls)

  const attach = (kind: 'Topic' | 'Channel', key: string, feed: FakeFeed): void => {
    feed.live = true
    calls.push({
      method: `subscribe${kind}Messages`,
      args:
        kind === 'Topic'
          ? { topicId: key, channelName: feed.channelName, boundSessionId: sessionId }
          : { channelName: key, boundSessionId: sessionId },
      deliver: (msg) => {
        if (feed.live) feed.onEvent(msg)
      },
    })
  }
  const detach = (kind: 'Topic' | 'Channel', key: string, feed: FakeFeed): void => {
    if (!feed.live) return
    feed.live = false
    calls.push({ method: `unsubscribe${kind}`, args: kind === 'Topic' ? { topicId: key } : { channelName: key } })
  }

  const remote = {
    ...base,
    introduce: async (args: Record<string, unknown>): Promise<void> => {
      introduceCount += 1
      calls.push({ method: 'introduce', args })
      if (
        (opts?.introduceThrowsAfter !== undefined && introduceCount > opts.introduceThrowsAfter) ||
        opts?.introduceThrowsOnCall === introduceCount
      ) {
        throw new Error(`introduce blip on ${source}`)
      }
      const previousSessionId = sessionId
      const previousOrg = boundOrg
      const organizationId = args.organizationId as string | undefined
      // The backend row is keyed by (user, org, sessionName), so the id moves
      // when EITHER changes — an org-only switch rebinds just as a rename does.
      sessionId = `session_${String(args.sessionName)}${organizationId !== undefined ? `@${organizationId}` : ''}`
      boundOrg = organizationId
      if (previousSessionId === null || previousSessionId === sessionId) return

      const orgChanged =
        previousOrg !== undefined && organizationId !== undefined && previousOrg !== organizationId
      if (orgChanged) {
        for (const [topicId, feed] of [...topicFeeds]) {
          topicFeeds.delete(topicId)
          detach('Topic', topicId, feed)
        }
      } else {
        for (const [topicId, feed] of topicFeeds) detach('Topic', topicId, feed)
      }
      for (const [name, feed] of channelFeeds) detach('Channel', name, feed)
    },
    joinChannel: async (args: Record<string, unknown>): Promise<{ subscriberCount: number }> => {
      calls.push({ method: 'joinChannel', args })
      const name = String(args.channel)
      const feed = channelFeeds.get(name)
      if (feed !== undefined && !feed.live) attach('Channel', name, feed)
      return { subscriberCount: 1 }
    },
    joinTopic: async (args: Record<string, unknown>): Promise<{ history: [] }> => {
      calls.push({ method: 'joinTopic', args })
      const topicId = String(args.topicId)
      const feed = topicFeeds.get(topicId)
      if (feed !== undefined && !feed.live) attach('Topic', topicId, feed)
      return { history: [] }
    },
    leaveChannel: async (args: Record<string, unknown>): Promise<void> => {
      const name = String(args.channel)
      const feed = channelFeeds.get(name)
      if (feed !== undefined) detach('Channel', name, feed)
      for (const [topicId, t] of topicFeeds) {
        if (t.channelName === name) detach('Topic', topicId, t)
      }
      calls.push({ method: 'leaveChannel', args })
    },
    leaveTopic: async (args: Record<string, unknown>): Promise<void> => {
      const topicId = String(args.topicId)
      const feed = topicFeeds.get(topicId)
      if (feed !== undefined) detach('Topic', topicId, feed)
      calls.push({ method: 'leaveTopic', args })
    },
    primeTopicCursor: (topicId: string, ts: number): void => {
      calls.push({ method: 'primeTopicCursor', args: { topicId, ts } })
    },
    subscribeTopicMessages: (
      args: { topicId: string; channelName: string },
      onEvent: (msg: Record<string, unknown>) => void,
    ): (() => void) => {
      const existing = topicFeeds.get(args.topicId)
      if (existing !== undefined) return () => detach('Topic', args.topicId, existing)
      const feed: FakeFeed = { channelName: args.channelName, onEvent, live: false }
      topicFeeds.set(args.topicId, feed)
      attach('Topic', args.topicId, feed)
      return () => {
        topicFeeds.delete(args.topicId)
        detach('Topic', args.topicId, feed)
      }
    },
    subscribeChannelMessages: (
      args: { channelName: string },
      onEvent: (msg: Record<string, unknown>) => void,
    ): (() => void) => {
      const existing = channelFeeds.get(args.channelName)
      if (existing !== undefined) return () => detach('Channel', args.channelName, existing)
      const feed: FakeFeed = { channelName: args.channelName, onEvent, live: false }
      channelFeeds.set(args.channelName, feed)
      attach('Channel', args.channelName, feed)
      return () => {
        channelFeeds.delete(args.channelName)
        detach('Channel', args.channelName, feed)
      }
    },
    forgetTopicFeed: (topicId: string): void => {
      const feed = topicFeeds.get(topicId)
      if (feed === undefined) return
      topicFeeds.delete(topicId)
      detach('Topic', topicId, feed)
    },
    forgetChannelFeed: (name: string): void => {
      const feed = channelFeeds.get(name)
      if (feed !== undefined) {
        channelFeeds.delete(name)
        detach('Channel', name, feed)
      }
      for (const [topicId, t] of [...topicFeeds]) {
        if (t.channelName !== name) continue
        topicFeeds.delete(topicId)
        detach('Topic', topicId, t)
      }
    },
    suspendedFeeds: (): { topics: string[]; channels: string[] } => ({
      topics: [...topicFeeds].filter(([, f]) => !f.live).map(([id]) => id),
      channels: [...channelFeeds].filter(([, f]) => !f.live).map(([n]) => n),
    }),
    // Liveness is MEMBERSHIP-driven in the tool layer: a feed that does not
    // exist is just as deaf as one that is suspended. Modelling only
    // `suspendedFeeds` is what let a missing feed pass for a healthy one.
    hasLiveTopicFeed: (topicId: string): boolean => topicFeeds.get(topicId)?.live === true,
    hasLiveChannelFeed: (name: string): boolean => channelFeeds.get(name)?.live === true,
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

        const joinChannelAt = calls.findIndex((c) => c.method === 'joinChannel')
        const joinTopicAt = calls.findIndex((c) => c.method === 'joinTopic')
        // Guard against a vacuous `-1 < n`: both steps must actually occur.
        expect(joinChannelAt).toBeGreaterThanOrEqual(0)
        expect(joinTopicAt).toBeGreaterThanOrEqual(0)
        expect(joinChannelAt).toBeLessThan(joinTopicAt)
      })

      it('leaves nothing on a first introduce when nothing was joined under the prior identity', async () => {
        // Nothing joined yet ⇒ even though the prior display name is the
        // username fallback, there is no membership to tear down. (The case
        // where a channel WAS auto-joined under the username is covered by
        // 'tears down the username ghost…' below.)
        const calls: RecordedCall[] = []
        const deps = makeRecordingDeps(calls)

        await handleIdentityTool('introduce', { name: 'kai-408' }, deps)

        expect(calls.filter((c) => c.method === 'leaveTopic' || c.method === 'leaveChannel')).toEqual([])
        expect(calls.map((c) => c.method)).toEqual(['introduce'])
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
          transport: Transport
          result: string
        }> {
          const transport = makeRecordingRemoteTransport('remote', calls)
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
          }

          // Boot as the config's default name: join the channel, introduce,
          // join a topic, and auto-subscribe — exactly what attach.ts does
          // before the agent gets a chance to say who it really is.
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport, channelName: 'kai', messageBus })
          ensureTopicSubscription({ transport, topicId: 'topic_1', channelName: 'kai', messageBus })
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)
          return { deps, transport, result }
        }

        it('leaves the session subscribed, under the NEW session row, after a rename', async () => {
          // Rewritten for KAI-418: the TOOL no longer unsubscribes and
          // re-subscribes — the transport suspends its own feeds when the row
          // rebinds and re-attaches them on the re-joins. The BEHAVIOUR this
          // has always protected is unchanged and still pinned here: after a
          // rename the session is still subscribed, bound to the new row, with
          // no duplicate feed and nothing left deaf.
          const calls: RecordedCall[] = []
          const { deps } = await renameWithLiveSubscriptions(calls)
          const transport = deps.router.get('remote') as Transport & {
            suspendedFeeds: () => { topics: string[]; channels: string[] }
          }

          // The feeds went down while the old identity's memberships were being
          // left, and came back up on the re-joins — exactly once each.
          expect(calls.filter((c) => c.method === 'unsubscribeTopic')).toHaveLength(1)
          expect(calls.filter((c) => c.method === 'unsubscribeChannel')).toHaveLength(1)
          const topicSub = calls.filter((c) => c.method === 'subscribeTopicMessages')
          const channelSub = calls.filter((c) => c.method === 'subscribeChannelMessages')
          expect(topicSub).toHaveLength(1)
          expect(channelSub).toHaveLength(1)
          expect(topicSub[0]!.args).toMatchObject({ topicId: 'topic_1', boundSessionId: 'session_kai-408@org_a' })
          expect(channelSub[0]!.args).toMatchObject({ channelName: 'kai', boundSessionId: 'session_kai-408@org_a' })

          // Nothing is left suspended ⇒ the session is not deaf anywhere.
          expect(transport.suspendedFeeds()).toEqual({ topics: [], channels: [] })
        })

        it('re-subscribes only after the introduce fan-out and the re-joins', async () => {
          const calls: RecordedCall[] = []
          await renameWithLiveSubscriptions(calls)

          const at = (method: string): number => {
            const i = calls.findIndex((c) => c.method === method)
            // Guard: a `-1` (absent) index would satisfy a `<` ordering
            // assertion vacuously. Require the step actually happened.
            expect(i, `expected a "${method}" call`).toBeGreaterThanOrEqual(0)
            return i
          }
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

        it('without a message bus it cannot create feeds — so it says so, rather than lying', async () => {
          // Legacy deps construct IdentityToolDeps without the hot-attach
          // plumbing. That must not crash the rename — but it must not report a
          // clean success either: with no MessageBus there is no callback to
          // build a feed from, so the session genuinely cannot hear, and saying
          // otherwise is exactly the silent-deafness lie this area exists to
          // kill. It still performs the membership migration itself.
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

          expect(JSON.parse(result)).toEqual({ name: 'kai-408', degraded: ['remote'] })
          expect(calls.some((c) => c.method.startsWith('subscribe'))).toBe(false)
          expect(calls.map((c) => c.method)).toEqual([
            'leaveTopic',
            'leaveChannel',
            'introduce',
            'joinChannel',
            'joinTopic',
          ])
        })

        it('still DELIVERS after a rename, through the ORIGINAL callback, with no duplicate feed', async () => {
          // Rewritten for KAI-418. The old version asserted that the
          // pre-rename callback was DEAD and a NEW one had replaced it — that
          // was an artefact of the tool tearing feeds down and re-creating
          // them. The transport now keeps ONE feed per topic/channel across the
          // rebind (a stable handle, the original onEvent) and merely
          // re-attaches it. So the question this test exists to answer is
          // unchanged — after a rename, can the session still hear? — but the
          // mechanism it asserts is the new one.
          const calls: RecordedCall[] = []
          const pushed: Array<{ text: string; source: string }> = []
          const messageBus = {
            push: vi.fn(async (msg: { text: string }, source: string) => {
              pushed.push({ text: msg.text, source })
            }),
          } as unknown as MessageBus
          const transport = makeRecordingRemoteTransport('remote', calls)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
          }
          // Both memberships exist before the rename, and the TOOL owns creating
          // their feeds (it holds the MessageBus callback — the real production
          // wiring). We deliberately do NOT hand-subscribe with a private
          // callback here: that would test a callback nothing in production uses,
          // and would silently shadow the feed the tool creates.
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          calls.length = 0

          await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          // Exactly ONE feed each was re-attached — no duplicate stacked on the
          // rebind — and it carries the new row.
          const topicSub = calls.filter((c) => c.method === 'subscribeTopicMessages')
          const channelSub = calls.filter((c) => c.method === 'subscribeChannelMessages')
          expect(topicSub).toHaveLength(1)
          expect(channelSub).toHaveLength(1)
          expect(topicSub[0]!.args.boundSessionId).toBe('session_kai-408@org_a')
          expect(channelSub[0]!.args.boundSessionId).toBe('session_kai-408@org_a')

          // And it really delivers, all the way to the MessageBus, tagged with
          // the location — which is the only delivery that means anything.
          topicSub[0]!.deliver!({ text: 'topic-after-rename' })
          channelSub[0]!.deliver!({ text: 'chan-after-rename' })
          expect(pushed).toEqual([
            { text: 'topic-after-rename', source: 'remote' },
            { text: 'chan-after-rename', source: 'remote' },
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
      /**
       * A migration that partially failed must be able to HEAL on a retry.
       *
       * When a rename's introduce throws at one location, its subscriptions
       * were already torn down and it is excluded from the re-join/resubscribe
       * — correctly reported as `degraded`. But the agent then does the natural
       * thing and retries with the SAME name, at which point `renamed` is false
       * and nothing marks the location as needing work: the channel re-join
       * loop (ungated) recreates backend membership while the subscriptions are
       * never re-registered, and the tool reports a CLEAN SUCCESS. The session
       * is permanently deaf on that location and is told it worked.
       *
       * The third trigger: a location that holds membership but has no live
       * subscription is STALE and must be restored.
       */
      describe('self-healing a partially-failed migration', () => {
        interface HealFixture {
          deps: IdentityToolDeps
          calls: RecordedCall[]
          transport: Transport
          messageBus: MessageBus
        }

        /** Remote with a channel + topic joined and both subscriptions live,
         *  then a rename whose introduce THROWS (leaving it torn down). */
        async function renameThatFailsAtRemote(opts: {
          introduceThrowsOnCall?: number
          introduceThrowsAfter?: number
        }): Promise<HealFixture> {
          const calls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const transport = makeRecordingRemoteTransport('remote', calls, opts)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport, channelName: 'kai', messageBus })
          ensureTopicSubscription({ transport, topicId: 'topic_1', channelName: 'kai', messageBus })

          // The rename: introduce throws at remote (call 2). The leaves already
          // suspended its feeds, and the failed introduce means they are never
          // re-joined — so the session is deaf there, and says so.
          const failed = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)
          expect(JSON.parse(failed).degraded).toEqual(['remote'])
          const suspended = transport as unknown as {
            suspendedFeeds: () => { topics: string[]; channels: string[] }
          }
          expect(suspended.suspendedFeeds()).toEqual({ topics: ['topic_1'], channels: ['kai'] })
          calls.length = 0

          return { deps, calls, transport, messageBus }
        }

        it('restores the suspended feeds on a same-name retry once introduce succeeds', async () => {
          // call 1 = bootstrap (ok), call 2 = the failing rename, call 3 = the retry (ok).
          const { deps, calls, transport } = await renameThatFailsAtRemote({ introduceThrowsOnCall: 2 })
          const suspended = transport as unknown as {
            suspendedFeeds: () => { topics: string[]; channels: string[] }
          }

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          // The tool re-joins the memberships; the TRANSPORT re-attaches the
          // feeds off the back of those joins, under the new row.
          expect(calls.some((c) => c.method === 'joinTopic' && c.args.sessionName === 'kai-408')).toBe(true)
          const topicSub = calls.find((c) => c.method === 'subscribeTopicMessages')
          const channelSub = calls.find((c) => c.method === 'subscribeChannelMessages')
          expect(topicSub!.args).toMatchObject({ topicId: 'topic_1', boundSessionId: 'session_kai-408@org_a' })
          expect(channelSub!.args).toMatchObject({ channelName: 'kai', boundSessionId: 'session_kai-408@org_a' })
          expect(suspended.suspendedFeeds()).toEqual({ topics: [], channels: [] })

          // Healed ⇒ no longer degraded.
          expect(JSON.parse(result).degraded).toBeUndefined()
        })

        it('actually DELIVERS again after healing', async () => {
          // "subscribe was called" is not "the session can hear".
          const { deps, calls, messageBus } = await renameThatFailsAtRemote({ introduceThrowsOnCall: 2 })

          await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          const topicSub = calls.find((c) => c.method === 'subscribeTopicMessages')!
          const channelSub = calls.find((c) => c.method === 'subscribeChannelMessages')!
          topicSub.deliver!({ text: 'healed-topic' })
          channelSub.deliver!({ text: 'healed-chan' })

          expect(messageBus.push).toHaveBeenCalledWith(expect.objectContaining({ text: 'healed-topic' }), 'remote')
          expect(messageBus.push).toHaveBeenCalledWith(expect.objectContaining({ text: 'healed-chan' }), 'remote')
        })

        it('stays truthful when the retry cannot heal either', async () => {
          // introduce keeps throwing ⇒ still deaf ⇒ must still say `degraded`.
          const { deps } = await renameThatFailsAtRemote({ introduceThrowsAfter: 1 })

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          expect(JSON.parse(result).degraded).toEqual(['remote'])
        })

        it('reports degraded when introduce SUCCEEDS but a feed cannot be restored', async () => {
          // Rewritten for KAI-418: the tool no longer re-subscribes, so "the
          // re-subscribe threw" is not a thing that can happen to it any more.
          // The PROPERTY it protected is unchanged and still essential — a
          // location that ends up unable to deliver must never be handed back
          // as a clean success — so it is now provoked at the real seam: the
          // topic re-join fails, so the transport never re-attaches that feed
          // and the session stays deaf on it.
          const calls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const transport = makeRecordingRemoteTransport('remote', calls)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport, channelName: 'kai', messageBus })
          ensureTopicSubscription({ transport, topicId: 'topic_1', channelName: 'kai', messageBus })

          // The topic re-join now fails (introduce and the channel re-join still
          // work), so the topic feed the leave suspended can never come back.
          // It still RECORDS the attempt, so the assertions below can tell
          // "attempted and failed" from "never attempted at all".
          const broken = transport as unknown as {
            joinTopic: (args: Record<string, unknown>) => Promise<never>
          }
          broken.joinTopic = (args: Record<string, unknown>): Promise<never> => {
            calls.push({ method: 'joinTopic', args })
            return Promise.reject(new Error('joinTopic exploded'))
          }

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          // introduce succeeded, so the location is NOT in `failed` for that
          // reason, and the tool really did try to re-join the topic (without
          // this, "the feed stayed suspended" could equally mean the re-join was
          // never attempted, and the test would pass for the wrong reason)...
          expect(calls.some((c) => c.method === 'introduce' && c.args.sessionName === 'kai-408')).toBe(true)
          expect(calls.some((c) => c.method === 'joinTopic')).toBe(true)
          // ...but a feed is still suspended, so the session is deaf there...
          const suspended = transport as unknown as {
            suspendedFeeds: () => { topics: string[]; channels: string[] }
          }
          expect(suspended.suspendedFeeds().topics).toEqual(['topic_1'])
          // ...and we say so rather than reporting a clean success.
          expect(JSON.parse(result).degraded).toEqual(['remote'])
        })

        it('never treats LOCAL as stale (the broker has no per-feed subscriptions)', async () => {
          // The local broker delivers over one shared SSE stream and holds NO
          // per-channel/per-topic subscription entries, so every local location
          // would look "missing" forever — churning a leave/re-join and a
          // pointless resubscribe on EVERY introduce.
          const calls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([makeRecordingTransport('local', calls)]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'local')
          await handleIdentityTool('introduce', { name: 'kai-408' }, deps)
          deps.context.joinTopic('uuid-1', 'KAI-408', 'kai', 'local')
          calls.length = 0

          await handleIdentityTool('introduce', { name: 'kai-408' }, deps)

          expect(calls.some((c) => c.method === 'leaveChannel')).toBe(false)
          expect(calls.some((c) => c.method === 'leaveTopic')).toBe(false)
          expect(calls.some((c) => c.method === 'joinTopic')).toBe(false)
          expect(calls.map((c) => c.method)).toEqual(['introduce', 'joinChannel'])
        })

        it('leaves a healthy same-name re-introduce as a no-op', async () => {
          // Everything live and subscribed ⇒ nothing is stale ⇒ no teardown, no
          // topic re-join, no re-subscribe.
          const calls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const transport = makeRecordingRemoteTransport('remote', calls)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport, channelName: 'kai', messageBus })
          ensureTopicSubscription({ transport, topicId: 'topic_1', channelName: 'kai', messageBus })
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          expect(calls.map((c) => c.method)).toEqual(['introduce', 'joinChannel'])
          expect(JSON.parse(result)).toEqual({ name: 'kai-408' })
        })
      })

      describe('introduce failure mid-fan-out', () => {
        it('skips re-join and resubscribe for the failed location and reports it as degraded', async () => {
          const calls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          // Bootstrap introduce succeeds; the rename introduce throws.
          const transport = makeRecordingRemoteTransport('remote', calls, { introduceThrowsAfter: 1 })
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport, channelName: 'kai', messageBus })
          ensureTopicSubscription({ transport, topicId: 'topic_1', channelName: 'kai', messageBus })
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

        it('migrates the HEALTHY location while skipping only the failed one', async () => {
          // Single-transport coverage cannot tell "skip this location" from
          // "skip everything". With two transports the gate has to be
          // per-location: a remote blip must NOT evict the session from its
          // LOCAL channels/topics (the leaves already ran, so skipping the
          // local re-join would strand it), and a healthy local must NOT drag
          // the failed remote into a resubscribe under its stale session id.
          const localCalls: RecordedCall[] = []
          const remoteCalls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const local = makeRecordingTransport('local', localCalls)
          const remote = makeRecordingRemoteTransport('remote', remoteCalls, { introduceThrowsAfter: 1 })
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([local, remote]),
            messageBus,
          }
          // A channel AND a topic joined at EACH location.
          deps.context.joinChannel('kai', 'cccollab.json', 'local')
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
          deps.context.joinTopic('topic_local', 'KAI-408', 'kai', 'local')
          deps.context.joinTopic('topic_remote', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport: remote, channelName: 'kai', messageBus })
          ensureTopicSubscription({ transport: remote, topicId: 'topic_remote', channelName: 'kai', messageBus })
          localCalls.length = 0
          remoteCalls.length = 0

          // The rename: local introduce succeeds, remote introduce throws.
          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          // LOCAL is migrated fully, under the new name.
          expect(localCalls.some((c) => c.method === 'joinChannel' && c.args.sessionName === 'kai-408')).toBe(true)
          expect(localCalls.some((c) => c.method === 'joinTopic' && c.args.sessionName === 'kai-408')).toBe(true)

          // REMOTE gets nothing after its failed introduce — no join under the
          // stale id, and no resubscribe bound to it.
          expect(remoteCalls.some((c) => c.method === 'joinChannel')).toBe(false)
          expect(remoteCalls.some((c) => c.method === 'joinTopic')).toBe(false)
          expect(remoteCalls.some((c) => c.method === 'subscribeChannelMessages')).toBe(false)
          expect(remoteCalls.some((c) => c.method === 'subscribeTopicMessages')).toBe(false)

          expect(JSON.parse(result)).toEqual({ name: 'kai-408', degraded: ['remote'] })
        })

        it('reports a location that is already disabled at rename time as degraded', async () => {
          // A location that self-disabled BEFORE the rename is excluded from
          // router.enabled(), so it lands in neither `introduced` nor `failed`:
          // its subscriptions get torn down (teardown walks the context, not the
          // router) and are never restored, and its old-name memberships cannot
          // be left (router.get throws). The ghost silently persists there — so
          // a bare success would be a lie. We genuinely cannot migrate it; say so.
          const localCalls: RecordedCall[] = []
          const remoteCalls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const local = makeRecordingTransport('local', localCalls)
          const remote = makeRecordingRemoteTransport('remote', remoteCalls)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([local, remote]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'local')
          deps.context.joinChannel('ops', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)

          // The remote self-disables (graceful degradation) before the rename.
          remote.enabled = false
          localCalls.length = 0
          remoteCalls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'kai-408', organization: 'org_a' }, deps)

          // The healthy local location is migrated...
          expect(localCalls.some((c) => c.method === 'joinChannel' && c.args.sessionName === 'kai-408')).toBe(true)
          // ...and the un-migratable one is reported rather than passed off as success.
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

      /**
       * The backend keys CLI sessions by (user, org, sessionName), so a
       * same-name re-introduce into a DIFFERENT organization rebinds the
       * backend row exactly like a rename does — but the migration guard only
       * fires on a name change, so the org-only case would skip teardown and
       * orphan the old memberships. We can't tell "same org via slug vs id"
       * from "genuinely different org" here (that lives in the backend), so we
       * REJECT rather than half-migrate.
       */
      describe('organization change', () => {
        /** A remote location with a channel and a topic joined, introduced into org_1. */
        async function remoteInOrg1(
          calls: RecordedCall[],
          opts?: { introduceThrowsOnCall?: number },
        ): Promise<{
          deps: IdentityToolDeps
          transport: Transport
        }> {
          const transport = makeRecordingRemoteTransport('remote', calls, opts)
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'a', organization: 'org_1' }, deps)
          deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
          ensureChannelSubscription({ transport, channelName: 'kai', messageBus })
          ensureTopicSubscription({ transport, topicId: 'topic_1', channelName: 'kai', messageBus })
          return { deps, transport }
        }

        const indexOf = (calls: RecordedCall[], method: string): number => {
          const i = calls.findIndex((c) => c.method === method)
          expect(i, `expected a "${method}" call`).toBeGreaterThanOrEqual(0)
          return i
        }

        it('migrates the location on an org-only change and DROPS its foreign-org topics', async () => {
          // A location's backend row is keyed by (user, org, sessionName), so an
          // org change rebinds it exactly like a rename does — the old identity
          // must be torn down first or it ghosts the OLD org. Channels are
          // addressed by NAME and re-resolve in the new org, so they carry
          // across. Topic IDS belong to the old org and are meaningless in the
          // new one, so they are dropped — and REPORTED, never silently.
          const calls: RecordedCall[] = []
          const { deps } = await remoteInOrg1(calls)
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'a', organization: 'org_2' }, deps)

          // The old identity is torn down while still bound to the OLD org row.
          expect(indexOf(calls, 'leaveTopic')).toBeLessThan(indexOf(calls, 'introduce'))
          expect(indexOf(calls, 'leaveChannel')).toBeLessThan(indexOf(calls, 'introduce'))
          expect(calls.find((c) => c.method === 'leaveTopic')!.args).toMatchObject({
            sessionName: 'a',
            topicId: 'topic_1',
          })
          expect(calls.find((c) => c.method === 'introduce')!.args).toMatchObject({ organizationId: 'org_2' })

          // The channel carries across (re-joined by name in the new org)...
          expect(calls.some((c) => c.method === 'joinChannel' && c.args.channel === 'kai')).toBe(true)
          // ...the foreign-org topic id is never re-joined or re-subscribed...
          expect(calls.some((c) => c.method === 'joinTopic')).toBe(false)
          expect(calls.some((c) => c.method === 'subscribeTopicMessages')).toBe(false)
          // ...it is gone from the session's context...
          expect(deps.context.getJoinedTopics()).toEqual([])
          // ...and the user is TOLD it was dropped.
          expect(JSON.parse(result)).toEqual({
            name: 'a',
            droppedTopics: [{ topic: 'KAI-408', channel: 'kai', location: 'remote' }],
          })
        })

        it('never drops LOCAL topics on an org change (the broker is single-tenant)', async () => {
          // The single most dangerous mistake available here: treating the local
          // location as org-changed would tear down and DROP the user's local
          // topics on an org switch. The broker ignores organizationId entirely.
          const localCalls: RecordedCall[] = []
          const remoteCalls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const local = makeRecordingTransport('local', localCalls)
          const remote = makeRecordingRemoteTransport('remote', remoteCalls)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([local, remote]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'local')
          deps.context.joinChannel('ops', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'a', organization: 'org_1' }, deps)
          deps.context.joinTopic('topic_local', 'Local work', 'kai', 'local')
          deps.context.joinTopic('topic_remote', 'Remote work', 'ops', 'remote')
          ensureChannelSubscription({ transport: remote, channelName: 'ops', messageBus })
          ensureTopicSubscription({ transport: remote, topicId: 'topic_remote', channelName: 'ops', messageBus })
          localCalls.length = 0
          remoteCalls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'a', organization: 'org_2' }, deps)

          // The REMOTE topic is dropped and reported...
          expect(JSON.parse(result).droppedTopics).toEqual([
            { topic: 'Remote work', channel: 'ops', location: 'remote' },
          ])
          // ...while the LOCAL topic survives untouched: never left, still joined.
          expect(deps.context.getJoinedTopics().map((t) => t.threadTs)).toEqual(['topic_local'])
          expect(localCalls.some((c) => c.method === 'leaveTopic')).toBe(false)
          expect(localCalls.some((c) => c.method === 'leaveChannel')).toBe(false)
        })

        it('treats LOCAL as never org-changed even if a local org binding somehow exists', async () => {
          // Defense in depth, and the rule itself rather than just its outcome.
          // Nothing records an org for the local broker today (single-tenant, it
          // ignores organizationId), so the outcome test above passes even
          // without the LOCAL guard on the org-changed snapshot. Seed a local
          // binding directly: local must STILL never count as org-changed, or a
          // future change that starts recording one would silently drop every
          // local topic on an org switch.
          const localCalls: RecordedCall[] = []
          const remoteCalls: RecordedCall[] = []
          const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
          const local = makeRecordingTransport('local', localCalls)
          const remote = makeRecordingRemoteTransport('remote', remoteCalls)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([local, remote]),
            messageBus,
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'local')
          deps.context.joinChannel('ops', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'a', organization: 'org_1' }, deps)
          deps.context.joinTopic('topic_local', 'Local work', 'kai', 'local')
          // Force the condition the LOCAL guard exists to withstand.
          deps.session.setOrganizationFor('local', 'org_1')
          localCalls.length = 0
          remoteCalls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'a', organization: 'org_2' }, deps)

          expect(deps.context.getJoinedTopics().map((t) => t.threadTs)).toEqual(['topic_local'])
          expect(localCalls.some((c) => c.method === 'leaveTopic')).toBe(false)
          expect(localCalls.some((c) => c.method === 'leaveChannel')).toBe(false)
          expect(JSON.parse(result).droppedTopics).toBeUndefined()
        })

        it('re-joins the channel under the new name and drops foreign-org topics on a name+org change', async () => {
          const calls: RecordedCall[] = []
          const { deps } = await remoteInOrg1(calls)
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'b', organization: 'org_2' }, deps)

          expect(calls.find((c) => c.method === 'leaveChannel')!.args).toMatchObject({ sessionName: 'a' })
          expect(calls.some((c) => c.method === 'joinChannel' && c.args.sessionName === 'b')).toBe(true)
          expect(calls.some((c) => c.method === 'joinTopic')).toBe(false)
          expect(JSON.parse(result)).toEqual({
            name: 'b',
            droppedTopics: [{ topic: 'KAI-408', channel: 'kai', location: 'remote' }],
          })
        })

        it('still migrates on a later introduce after a FAILED org change', async () => {
          // Round-trip with the per-location binding: the failed attempt never
          // recorded org_2, so the location is still known to be on org_1 and
          // the next successful introduce must STILL migrate it.
          const calls: RecordedCall[] = []
          // call 1 = bootstrap (ok), call 2 = the failing org change, call 3 = ok.
          const { deps } = await remoteInOrg1(calls, { introduceThrowsOnCall: 2 })

          const failedAttempt = await handleIdentityTool('introduce', { name: 'a', organization: 'org_2' }, deps)
          expect(JSON.parse(failedAttempt).degraded).toEqual(['remote'])
          expect(deps.session.getOrganizationFor('remote')).toBe('org_1')
          calls.length = 0

          const result = await handleIdentityTool('introduce', { name: 'a', organization: 'org_2' }, deps)

          // The migration still happens: old identity left, foreign-org topic dropped.
          expect(calls.some((c) => c.method === 'leaveChannel' && c.args.sessionName === 'a')).toBe(true)
          expect(calls.some((c) => c.method === 'joinTopic')).toBe(false)
          expect(deps.context.getJoinedTopics()).toEqual([])
          expect(JSON.parse(result)).toEqual({
            name: 'a',
            droppedTopics: [{ topic: 'KAI-408', channel: 'kai', location: 'remote' }],
          })
          expect(deps.session.getOrganizationFor('remote')).toBe('org_2')
        })

        it('an org-less re-introduce does not erase a location’s tracked org', async () => {
          // Once every remote has self-disabled, the `hasRemote` gate no longer
          // requires an `organization`, so an org-less re-introduce is
          // reachable. It must not ERASE the tracked binding — the location is
          // still on org_1 on its backend, and forgetting that would make the
          // next introduce believe there is nothing to migrate.
          const calls: RecordedCall[] = []
          const transport = makeRecordingRemoteTransport('remote', calls)
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([transport]),
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'a', organization: 'org_1' }, deps)

          // The remote self-disables; an org-less re-introduce now passes the gate.
          transport.enabled = false
          await handleIdentityTool('introduce', { name: 'a' }, deps)

          expect(deps.session.getOrganizationFor('remote')).toBe('org_1')
        })

        it('does not record the new org for a location whose introduce FAILED', async () => {
          // The org binding is per-location and is only true once that
          // location's backend row actually rebound. Recording it globally and
          // unconditionally means a location whose introduce threw is still on
          // the OLD org on its backend while we believe it is on the new one —
          // so the NEXT re-introduce sees "no change" there, skips its
          // migration, and leaves the ghost behind.
          const calls: RecordedCall[] = []
          const remote = makeRecordingRemoteTransport('remote', calls, { introduceThrowsAfter: 1 })
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([remote]),
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'remote')
          await handleIdentityTool('introduce', { name: 'a', organization: 'org_1' }, deps)
          expect(deps.session.getOrganizationFor('remote')).toBe('org_1')

          // Name AND org change, but this location's introduce throws.
          await handleIdentityTool('introduce', { name: 'b', organization: 'org_2' }, deps)

          // Its row never rebound ⇒ it is still on org_1. Recording org_2 here
          // would silently disarm the next migration for this location.
          expect(deps.session.getOrganizationFor('remote')).toBe('org_1')
        })

        it('records the org per-location, and never for the single-tenant local broker', async () => {
          const localCalls: RecordedCall[] = []
          const remoteCalls: RecordedCall[] = []
          const deps: IdentityToolDeps = {
            session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
            context: new ActiveContext(),
            router: new TransportRouter([
              makeRecordingTransport('local', localCalls),
              makeRecordingRemoteTransport('remote', remoteCalls),
            ]),
          }
          deps.context.joinChannel('kai', 'cccollab.json', 'local')

          await handleIdentityTool('introduce', { name: 'a', organization: 'org_1' }, deps)

          expect(deps.session.getOrganizationFor('remote')).toBe('org_1')
          // The local broker is single-tenant and ignores organizationId, so an
          // org is meaningless there — and must never make local look "changed".
          expect(deps.session.getOrganizationFor('local')).toBeUndefined()
        })
      })

      /**
       * When there is no config `name`, the session boots with displayName =
       * username and hasName() === false, yet server.ts still auto-joins its
       * local channels under that username. The agent then introduces its
       * real name. Because the migration guard used to key off hasName(), the
       * username was never torn down and lingered as a local ghost — the same
       * bug class, for the no-name path. The prior identity must be the
       * EFFECTIVE display name (username fallback included), not only an
       * explicitly-set name.
       */
      it('tears down the username ghost when a no-config-name session introduces a real name', async () => {
        const calls: RecordedCall[] = []
        const deps: IdentityToolDeps = {
          // No name set ⇒ displayName falls back to the username.
          session: new SessionManager({ username: 'samuel', cwd: '/projects/dispatcher' }),
          context: new ActiveContext(),
          router: new TransportRouter([makeRecordingTransport('local', calls)]),
        }
        // Simulate server.ts's pre-introduce local auto-join under the username.
        deps.context.joinChannel('kai', 'cccollab.json', 'local')

        const result = await handleIdentityTool('introduce', { name: 'kai-408' }, deps)

        expect(JSON.parse(result)).toEqual({ name: 'kai-408' })
        const leave = calls.find((c) => c.method === 'leaveChannel')
        const join = calls.find((c) => c.method === 'joinChannel')
        expect(leave?.args).toMatchObject({ sessionName: 'samuel', channel: 'kai' })
        expect(join?.args).toMatchObject({ sessionName: 'kai-408', channel: 'kai' })
        // The ghost is dropped before the new identity re-joins.
        expect(calls.indexOf(leave!)).toBeLessThan(calls.indexOf(join!))
      })

      it('tears down the username ghost from TOPICS too, not just channels', async () => {
        // The channel path above says nothing about topics, which are the other
        // half of the ghost: server.ts auto-joins configured topics under the
        // same username fallback, and a topic membership left behind under it is
        // just as real a ghost as a channel one.
        const calls: RecordedCall[] = []
        const deps: IdentityToolDeps = {
          session: new SessionManager({ username: 'samuel', cwd: '/projects/dispatcher' }),
          context: new ActiveContext(),
          router: new TransportRouter([makeRecordingTransport('local', calls)]),
        }
        deps.context.joinChannel('kai', 'cccollab.json', 'local')
        deps.context.joinTopic('uuid-1', 'KAI-408', 'kai', 'local')

        await handleIdentityTool('introduce', { name: 'kai-408' }, deps)

        const leaveTopicAt = calls.findIndex((c) => c.method === 'leaveTopic')
        const joinTopicAt = calls.findIndex((c) => c.method === 'joinTopic')
        expect(leaveTopicAt).toBeGreaterThanOrEqual(0)
        expect(joinTopicAt).toBeGreaterThanOrEqual(0)
        expect(calls[leaveTopicAt]!.args).toMatchObject({ sessionName: 'samuel', topicId: 'uuid-1' })
        expect(calls[joinTopicAt]!.args).toMatchObject({ sessionName: 'kai-408', topicId: 'uuid-1' })
        // Left under the old identity before being re-joined under the new one.
        expect(leaveTopicAt).toBeLessThan(joinTopicAt)
        // Same-org rename ⇒ the topic is re-joined, never dropped.
        expect(deps.context.getJoinedTopics().map((t) => t.threadTs)).toEqual(['uuid-1'])
      })

      it('does not churn when a no-config-name session introduces its own username', async () => {
        const calls: RecordedCall[] = []
        const deps: IdentityToolDeps = {
          session: new SessionManager({ username: 'samuel', cwd: '/projects/dispatcher' }),
          context: new ActiveContext(),
          router: new TransportRouter([makeRecordingTransport('local', calls)]),
        }
        deps.context.joinChannel('kai', 'cccollab.json', 'local')

        await handleIdentityTool('introduce', { name: 'samuel' }, deps)

        // Introducing the same name the channel was already joined under is
        // not a rename: no ghost, so nothing to tear down.
        expect(calls.some((c) => c.method === 'leaveChannel')).toBe(false)
      })

      it('still introduces under the new name when the transport throws on leave/join', async () => {
        // The throwing overrides REPLACE the recording fns, so they record
        // nothing — meaning the call log alone cannot distinguish "the
        // migration attempted the leaves and they blew up" from "there is no
        // migration at all" (the pre-fix behaviour). Count the invocations
        // INSIDE the stubs so the test actually pins that they were attempted.
        const attempted = { leaveTopic: 0, leaveChannel: 0, joinTopic: 0 }
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        const calls: RecordedCall[] = []
        try {
          // Inlined rather than via bootstrapThenRename so the counters can be
          // zeroed after the bootstrap: that first introduce is itself a
          // username→bootstrap migration (the session starts nameless), which
          // would otherwise fold its own leaveChannel into these totals.
          const deps = makeRecordingDeps(calls, {
            leaveTopic: async () => {
              attempted.leaveTopic += 1
              throw new Error('leaveTopic exploded')
            },
            leaveChannel: async () => {
              attempted.leaveChannel += 1
              throw new Error('leaveChannel exploded')
            },
            joinTopic: async () => {
              attempted.joinTopic += 1
              throw new Error('joinTopic exploded')
            },
          })
          deps.context.joinChannel('kai', 'cccollab.json', 'local')
          await handleIdentityTool('introduce', { name: 'bootstrap' }, deps)
          deps.context.joinTopic('uuid-1', 'KAI-408', 'kai', 'local')
          calls.length = 0
          attempted.leaveTopic = 0
          attempted.leaveChannel = 0
          attempted.joinTopic = 0
          stderr.mockClear()

          const result = await handleIdentityTool('introduce', { name: 'kai-408' }, deps)

          expect(JSON.parse(result)).toEqual({ name: 'kai-408' })
          expect(deps.session.displayName).toBe('kai-408')
          expect(calls.map((c) => c.method)).toEqual(['introduce', 'joinChannel'])
          // The migration really did attempt each step (and survived them).
          expect(attempted).toEqual({ leaveTopic: 1, leaveChannel: 1, joinTopic: 1 })

          // A swallowed teardown is exactly the ghost this migration exists to
          // prevent, so each failure must leave a trace on stderr rather than
          // vanish.
          const warnings = stderr.mock.calls.map((c) => String(c[0])).join('\n')
          expect(warnings).toMatch(/identity migration.*leaveTopic.*bootstrap/)
          expect(warnings).toMatch(/identity migration.*leaveChannel.*bootstrap/)
        } finally {
          stderr.mockRestore()
        }
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
