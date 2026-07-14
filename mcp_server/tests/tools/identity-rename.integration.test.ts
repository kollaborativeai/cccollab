import { describe, it, expect, vi } from 'vitest'
import type { ConvexClient } from 'convex/browser'
import { getFunctionName } from 'convex/server'

import { ActiveContext } from '../../src/context.js'
import { SessionManager } from '../../src/session.js'
import { TransportRouter } from '../../src/transport/router.js'
import { RemoteTransport } from '../../src/transport/remote.js'
import { ensureChannelSubscription, ensureTopicSubscription } from '../../src/transport/attach.js'
import { handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import type { MessageBus } from '../../src/message-bus.js'
import type { ParsedMessage } from '../../src/types.js'

/**
 * The tool/transport SEAM, end to end (KAI-418).
 *
 * Every other identity test drives a hand-written fake transport, and the
 * transport's own tests drive it without the tool. Both are green even when the
 * other side is broken — so on their own they cannot catch the fake DRIFTING
 * from the real contract, which is the one thing that would let this refactor
 * silently regress.
 *
 * This test wires the REAL `handleIdentityTool` to the REAL `RemoteTransport`
 * (over a stub ConvexClient) and asks the only question that matters:
 *
 *   after a rename, is the session still subscribed, bound to the new backend
 *   session row, and does a peer message actually reach the MessageBus?
 *
 * Nothing in `tools/identity.ts` touches a subscription to make that true.
 */

interface Feed {
  query: string
  args: Record<string, unknown>
  cb: (rows: unknown) => void
  alive: boolean
}

const shortName = (ref: unknown): string => getFunctionName(ref as never).split('/')[1] ?? ''

function makeConvexStub(sessionIds: string[]): { client: ConvexClient; feeds: Feed[] } {
  const feeds: Feed[] = []
  let introduceCount = 0
  const client = {
    mutation: vi.fn(async (ref: unknown, _args: Record<string, unknown>) => {
      const name = shortName(ref)
      if (name === 'sessions:introduce') {
        const id = sessionIds[Math.min(introduceCount, sessionIds.length - 1)]!
        introduceCount += 1
        return id
      }
      if (name === 'channels:join') return { channelId: 'chan_dev', latestTs: 100 }
      if (name === 'topics:join') return { topicId: 'topic_1', channelId: 'chan_dev', name: 'KAI-418' }
      return undefined
    }),
    query: vi.fn(async () => []),
    onUpdate: vi.fn((ref: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void) => {
      const feed: Feed = { query: shortName(ref), args, cb, alive: true }
      feeds.push(feed)
      return () => {
        feed.alive = false
      }
    }),
    setAuth: vi.fn(),
    close: vi.fn(async () => {}),
  }
  return { client: client as unknown as ConvexClient, feeds }
}

const liveFeed = (feeds: Feed[], query: string): Feed[] => feeds.filter((f) => f.alive && f.query === query)

describe('integration: rename over the real tool + real RemoteTransport', () => {
  it('keeps the session subscribed and DELIVERING, bound to the new session row', async () => {
    const { client, feeds } = makeConvexStub(['session_bootstrap', 'session_kai418'])
    const transport = new RemoteTransport({ client, source: 'remote', log: () => {} })
    const pushed: Array<{ msg: ParsedMessage; source: string }> = []
    const messageBus = {
      push: vi.fn(async (msg: ParsedMessage, source: string) => {
        pushed.push({ msg, source })
      }),
    } as unknown as MessageBus

    const deps: IdentityToolDeps = {
      session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
      context: new ActiveContext(),
      router: new TransportRouter([transport]),
      messageBus,
    }

    // Boot under the config's default name, join a channel + topic, auto-subscribe
    // — exactly what attach.ts does before the agent says who it really is.
    deps.context.joinChannel('dev', 'cccollab.json', 'remote')
    await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
    await transport.joinTopic({ sessionName: 'bootstrap', topicId: 'topic_1' })
    deps.context.joinTopic('topic_1', 'KAI-418', 'dev', 'remote')
    ensureChannelSubscription({ transport, channelName: 'dev', messageBus })
    ensureTopicSubscription({ transport, topicId: 'topic_1', channelName: 'dev', messageBus })

    expect(liveFeed(feeds, 'messages:listByTopic')[0]!.args).toMatchObject({ sessionId: 'session_bootstrap' })
    expect(liveFeed(feeds, 'messages:listByChannel')[0]!.args).toMatchObject({ sessionId: 'session_bootstrap' })

    // THE RENAME — the whole flow, through the real tool.
    const result = JSON.parse(await handleIdentityTool('introduce', { name: 'kai-418', organization: 'org_a' }, deps))

    // Nothing is degraded and nothing was dropped...
    expect(result).toEqual({ name: 'kai-418' })
    expect(transport.suspendedFeeds()).toEqual({ topics: [], channels: [] })

    // ...exactly one feed each is live, re-bound to the NEW backend row...
    const topicFeeds = liveFeed(feeds, 'messages:listByTopic')
    const channelFeeds = liveFeed(feeds, 'messages:listByChannel')
    expect(topicFeeds).toHaveLength(1)
    expect(channelFeeds).toHaveLength(1)
    expect(topicFeeds[0]!.args).toMatchObject({ sessionId: 'session_kai418', topicId: 'topic_1' })
    expect(channelFeeds[0]!.args).toMatchObject({ sessionId: 'session_kai418', channelId: 'chan_dev' })

    // ...and a peer message still reaches the MessageBus, tagged with the location.
    topicFeeds[0]!.cb([{ _id: 'm1', fromSessionId: 'peer', text: 'still-hearing-topics', ts: 900 }])
    channelFeeds[0]!.cb([{ _id: 'm2', fromSessionId: 'peer', text: 'still-hearing-channels', ts: 901 }])

    expect(pushed.map((p) => p.msg.text)).toEqual(['still-hearing-topics', 'still-hearing-channels'])
    expect(pushed.every((p) => p.source === 'remote')).toBe(true)
  })

  it('reports the location as degraded when the rename leaves it deaf', async () => {
    // The truthfulness property, across the real seam: introduce fails, so the
    // feeds the leaves suspended are never restored — and the tool must say so
    // rather than hand back a clean success.
    const { client, feeds } = makeConvexStub(['session_bootstrap'])
    const transport = new RemoteTransport({ client, source: 'remote', log: () => {} })
    const messageBus = { push: vi.fn(async () => {}) } as unknown as MessageBus
    const deps: IdentityToolDeps = {
      session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
      context: new ActiveContext(),
      router: new TransportRouter([transport]),
      messageBus,
    }

    deps.context.joinChannel('dev', 'cccollab.json', 'remote')
    await handleIdentityTool('introduce', { name: 'bootstrap', organization: 'org_a' }, deps)
    await transport.joinTopic({ sessionName: 'bootstrap', topicId: 'topic_1' })
    deps.context.joinTopic('topic_1', 'KAI-418', 'dev', 'remote')
    ensureChannelSubscription({ transport, channelName: 'dev', messageBus })
    ensureTopicSubscription({ transport, topicId: 'topic_1', channelName: 'dev', messageBus })

    // The rename's introduce now fails at the backend.
    ;(client.mutation as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (ref: unknown, _args: Record<string, unknown>) => {
        if (shortName(ref) === 'sessions:introduce') throw new Error('backend rejected introduce')
        return undefined
      },
    )

    const result = JSON.parse(await handleIdentityTool('introduce', { name: 'kai-418', organization: 'org_a' }, deps))

    expect(result.degraded).toEqual(['remote'])
    expect(transport.suspendedFeeds()).toEqual({ topics: ['topic_1'], channels: ['dev'] })
    expect(liveFeed(feeds, 'messages:listByTopic')).toHaveLength(0)
    expect(liveFeed(feeds, 'messages:listByChannel')).toHaveLength(0)
  })
})
