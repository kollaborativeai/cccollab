import { describe, it, expect, beforeEach } from 'vitest'

import { ActiveContext } from '../src/context.js'
import { restoreSubscriptions, snapshotSessionState } from '../src/session-persistence.js'
import type { SessionState } from '../src/session-state.js'
import { SESSION_STATE_VERSION } from '../src/session-state.js'
import type { Transport, TransportTopic } from '../src/transport/index.js'

/**
 * A transport that records what restore asked of it. The calls it records
 * ARE the contract: restore is defined as much by what it must never call
 * (`createTopic`) as by what it must.
 */
class RecordingTransport {
  readonly source = 'local'
  enabled = true
  readonly joinedChannels: string[] = []
  readonly joinedTopicIds: string[] = []
  readonly createdTopics: string[] = []
  readonly lookedUpIds: string[] = []
  /** Topics this backend knows about, by id. */
  private readonly topics = new Map<string, TransportTopic>()
  /** Force a wire failure for one topic id. */
  failJoinFor?: string
  failChannelJoin = false

  addTopic(t: Partial<TransportTopic> & { id: string; topic: string }): void {
    this.topics.set(t.id, {
      channel: 'dev',
      creator: 'someone',
      state: 'active',
      createdAt: '2026-01-01',
      ...t,
    })
  }

  hasTopic(id: string): boolean {
    return this.topics.has(id)
  }
  async introduce(): Promise<void> {}
  async joinChannel(args: { channel: string }): Promise<{ subscriberCount: number }> {
    if (this.failChannelJoin) throw new Error('broker unreachable')
    this.joinedChannels.push(args.channel)
    return { subscriberCount: 1 }
  }
  async leaveChannel(): Promise<void> {}
  async listChannels(): Promise<[]> {
    return []
  }
  async broadcast(): Promise<void> {}
  async createTopic(args: { topic: string }): Promise<TransportTopic> {
    // Restore must never reach this. Recorded rather than thrown so a
    // violating implementation fails on the explicit assertion below
    // (which names the hazard) instead of on an opaque rejection.
    this.createdTopics.push(args.topic)
    return { id: 'newly-created', topic: args.topic, channel: 'dev', creator: 'me', state: 'active', createdAt: 'now' }
  }
  async listTopics(): Promise<TransportTopic[]> {
    return [...this.topics.values()]
  }
  async getTopicById(args: { topicId: string }): Promise<TransportTopic | null> {
    this.lookedUpIds.push(args.topicId)
    return this.topics.get(args.topicId) ?? null
  }
  async joinTopic(args: { topicId: string }): Promise<{ history: [] }> {
    if (this.failJoinFor === args.topicId) throw new Error('join failed on the wire')
    this.joinedTopicIds.push(args.topicId)
    return { history: [] }
  }
  async leaveTopic(): Promise<void> {}
  async archiveTopic(): Promise<void> {}
  async unarchiveTopic(): Promise<void> {}
  async sendTopicMessage(): Promise<void> {}
  async listSessions(): Promise<[]> {
    return []
  }
  async readChannelMessages(): Promise<{ messages: []; hasMore: boolean }> {
    return { messages: [], hasMore: false }
  }
  async readTopicMessages(): Promise<{ messages: []; hasMore: boolean }> {
    return { messages: [], hasMore: false }
  }
  async deregisterSession(): Promise<void> {}
}

function stateOf(overrides: Partial<SessionState> = {}): SessionState {
  return {
    version: SESSION_STATE_VERSION,
    sessionId: 'uuid-a',
    channels: [{ name: 'dev', location: 'local', source: 'manual' }],
    topics: [],
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('restoreSubscriptions (KAI-415)', () => {
  let transport: RecordingTransport
  let context: ActiveContext

  function deps() {
    return {
      sessionName: 'my-session',
      context,
      transportFor: (location: string) => (location === 'local' ? (transport as unknown as Transport) : undefined),
    }
  }

  beforeEach(() => {
    transport = new RecordingTransport()
    context = new ActiveContext()
  })

  describe('channels', () => {
    it('re-joins a persisted channel on the wire and in local context', async () => {
      await restoreSubscriptions(stateOf(), deps())
      expect(transport.joinedChannels).toEqual(['dev'])
      expect(context.isChannelSubscribed('dev', 'local')).toBe(true)
    })

    it('labels a restored channel as "restored" so whoami shows memory survived a restart', async () => {
      await restoreSubscriptions(stateOf(), deps())
      expect(context.getChannelSource('dev', 'local')).toBe('restored')
    })

    it('restores channels at every location, not just local', async () => {
      const remote = new RecordingTransport()
      const state = stateOf({
        channels: [
          { name: 'dev', location: 'local', source: 'manual' },
          { name: 'ops', location: 'acme', source: 'manual' },
        ],
      })
      await restoreSubscriptions(state, {
        sessionName: 'my-session',
        context,
        transportFor: (loc) =>
          (loc === 'local' ? transport : loc === 'acme' ? remote : undefined) as unknown as Transport,
      })
      expect(transport.joinedChannels).toEqual(['dev'])
      expect(remote.joinedChannels).toEqual(['ops'])
    })

    it('skips a location whose transport is gone rather than throwing', async () => {
      const state = stateOf({ channels: [{ name: 'ops', location: 'vanished', source: 'manual' }] })
      await expect(restoreSubscriptions(state, deps())).resolves.toBeDefined()
      expect(context.isChannelSubscribed('ops')).toBe(false)
    })

    it('does not subscribe locally when the wire join fails - context must not claim a seat we do not have', async () => {
      transport.failChannelJoin = true
      await restoreSubscriptions(stateOf(), deps())
      expect(context.isChannelSubscribed('dev', 'local')).toBe(false)
    })
  })

  describe('topics: never create (HAZARD a)', () => {
    it('re-joins a topic that still exists, by id', async () => {
      transport.addTopic({ id: 'topic-1', topic: 'Auth' })
      const state = stateOf({ topics: [{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }] })

      await restoreSubscriptions(state, deps())

      expect(transport.joinedTopicIds).toEqual(['topic-1'])
      expect(context.isTopicJoined('topic-1')).toBe(true)
      expect(transport.createdTopics).toEqual([])
    })

    it('NEVER creates a topic that no longer exists - it stays gone', async () => {
      // The topic was deleted while the session was down. The pre-existing
      // startup path would look it up by name, miss, and CREATE it. Restore
      // must not: resurrection on every restart is worse than a missing seat.
      const state = stateOf({ topics: [{ id: 'topic-gone', name: 'Auth', channel: 'dev', location: 'local' }] })

      await restoreSubscriptions(state, deps())

      expect(transport.createdTopics).toEqual([])
      expect(transport.joinedTopicIds).toEqual([])
      expect(context.isTopicJoined('topic-gone')).toBe(false)
    })

    it('NEVER rejoins an archived topic - archiving it must survive a restart', async () => {
      transport.addTopic({ id: 'topic-1', topic: 'Auth', state: 'archived' })
      const state = stateOf({ topics: [{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }] })

      await restoreSubscriptions(state, deps())

      expect(transport.joinedTopicIds).toEqual([])
      expect(context.isTopicJoined('topic-1')).toBe(false)
      expect(transport.createdTopics).toEqual([])
    })

    it('never creates a topic even when the archived one is the ONLY thing it could restore', async () => {
      transport.addTopic({ id: 'topic-1', topic: 'Auth', state: 'archived' })
      const state = stateOf({ topics: [{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }] })
      await restoreSubscriptions(state, deps())
      expect(transport.createdTopics).toEqual([])
    })

    it('looks a topic up by ID, never by name - a new topic reusing an old name must not be joined', async () => {
      // The archived "Auth" (topic-1) was replaced by a fresh "Auth"
      // (topic-999) started by someone else. A name-based restore would
      // silently walk into a room this session never joined.
      transport.addTopic({ id: 'topic-999', topic: 'Auth' })
      const state = stateOf({ topics: [{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }] })

      await restoreSubscriptions(state, deps())

      expect(transport.lookedUpIds).toContain('topic-1')
      expect(transport.joinedTopicIds).toEqual([])
      expect(context.isTopicJoined('topic-999')).toBe(false)
    })

    it('keeps restoring the remaining topics after one has vanished', async () => {
      transport.addTopic({ id: 'topic-2', topic: 'Billing' })
      const state = stateOf({
        topics: [
          { id: 'topic-gone', name: 'Auth', channel: 'dev', location: 'local' },
          { id: 'topic-2', name: 'Billing', channel: 'dev', location: 'local' },
        ],
      })

      await restoreSubscriptions(state, deps())

      expect(context.isTopicJoined('topic-2')).toBe(true)
    })

    it('does not join a topic locally when the wire join fails', async () => {
      transport.addTopic({ id: 'topic-1', topic: 'Auth' })
      transport.failJoinFor = 'topic-1'
      const state = stateOf({ topics: [{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }] })

      await restoreSubscriptions(state, deps())

      expect(context.isTopicJoined('topic-1')).toBe(false)
    })

    it('skips a topic whose channel was not restored, rather than throwing', async () => {
      // context.joinTopic throws when the channel isn't subscribed.
      transport.addTopic({ id: 'topic-1', topic: 'Auth' })
      const state = stateOf({
        channels: [],
        topics: [{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }],
      })
      await expect(restoreSubscriptions(state, deps())).resolves.toBeDefined()
      expect(context.isTopicJoined('topic-1')).toBe(false)
    })
  })

  describe('active pointers', () => {
    it('restores the active channel the session was focused on', async () => {
      const state = stateOf({
        channels: [
          { name: 'dev', location: 'local', source: 'manual' },
          { name: 'ops', location: 'local', source: 'manual' },
        ],
        activeChannel: { name: 'ops', location: 'local' },
      })
      await restoreSubscriptions(state, deps())
      expect(context.getActiveChannelRef()).toEqual({ name: 'ops', location: 'local' })
    })

    it('restores the active topic the session was focused on', async () => {
      transport.addTopic({ id: 'topic-1', topic: 'Auth' })
      transport.addTopic({ id: 'topic-2', topic: 'Billing' })
      const state = stateOf({
        topics: [
          { id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' },
          { id: 'topic-2', name: 'Billing', channel: 'dev', location: 'local' },
        ],
        activeTopic: 'topic-1',
      })

      await restoreSubscriptions(state, deps())

      // Not simply "the last one joined" - topic-1 was joined first.
      expect(context.getThreadTs()).toBe('topic-1')
      expect(context.getTopicName()).toBe('Auth')
    })

    it('leaves no active topic when the persisted active one is gone', async () => {
      const state = stateOf({
        topics: [{ id: 'topic-gone', name: 'Auth', channel: 'dev', location: 'local' }],
        activeTopic: 'topic-gone',
      })
      await restoreSubscriptions(state, deps())
      expect(context.hasTopic()).toBe(false)
    })

    it('ignores an active channel that was not itself restored', async () => {
      const state = stateOf({ activeChannel: { name: 'never-joined', location: 'local' } })
      await restoreSubscriptions(state, deps())
      expect(context.getActiveChannel()).toBe('dev')
    })
  })

  describe('reporting', () => {
    it('reports what it actually restored, not what it was asked to restore', async () => {
      transport.addTopic({ id: 'topic-1', topic: 'Auth' })
      const state = stateOf({
        topics: [
          { id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' },
          { id: 'topic-gone', name: 'Ghost', channel: 'dev', location: 'local' },
        ],
      })

      const result = await restoreSubscriptions(state, deps())

      expect(result).toEqual({ channels: 1, topics: 1, skippedTopics: 1 })
    })
  })

  describe('snapshotSessionState (context -> disk)', () => {
    it('captures the channels and topics currently joined', () => {
      context.joinChannel('dev', 'manual', 'local')
      context.joinTopic('topic-1', 'Auth', 'dev', 'local')

      const snap = snapshotSessionState('uuid-a', context)

      expect(snap.sessionId).toBe('uuid-a')
      expect(snap.channels).toEqual([{ name: 'dev', location: 'local', source: 'manual' }])
      expect(snap.topics).toEqual([{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }])
    })

    it('captures the active channel and active topic pointers', () => {
      context.joinChannel('dev', 'manual', 'local')
      context.joinChannel('ops', 'manual', 'local')
      context.setActiveChannel('ops', 'local')
      context.joinTopic('topic-1', 'Auth', 'dev', 'local')

      const snap = snapshotSessionState('uuid-a', context)

      expect(snap.activeChannel).toEqual({ name: 'ops', location: 'local' })
      expect(snap.activeTopic).toBe('topic-1')
    })

    it('omits the active topic when there is none, rather than persisting a stale id', () => {
      context.joinChannel('dev', 'manual', 'local')
      context.joinTopic('topic-1', 'Auth', 'dev', 'local')
      context.leaveTopic('topic-1')

      const snap = snapshotSessionState('uuid-a', context)

      expect(snap.activeTopic).toBeUndefined()
      expect(snap.topics).toEqual([])
    })

    it('round-trips through restore: what a session had is what it gets back', async () => {
      // The two directions are only useful if they compose. Snapshot a live
      // context, restore it into a cold one, and the cold one must match.
      transport.addTopic({ id: 'topic-1', topic: 'Auth' })
      transport.addTopic({ id: 'topic-2', topic: 'Billing' })
      context.joinChannel('dev', 'manual', 'local')
      context.joinTopic('topic-1', 'Auth', 'dev', 'local')
      context.joinTopic('topic-2', 'Billing', 'dev', 'local')
      context.joinTopic('topic-1', 'Auth', 'dev', 'local') // refocus topic-1

      const snap = snapshotSessionState('uuid-a', context)

      const cold = new ActiveContext()
      await restoreSubscriptions(snap, {
        sessionName: 'my-session',
        context: cold,
        transportFor: () => transport as unknown as Transport,
      })

      expect(
        cold
          .getJoinedTopics()
          .map((t) => t.threadTs)
          .sort(),
      ).toEqual(['topic-1', 'topic-2'])
      expect(cold.getActiveChannelRef()).toEqual({ name: 'dev', location: 'local' })
      expect(cold.getThreadTs()).toBe('topic-1')
    })

    it('stamps a version and an updatedAt so the file can be aged out and migrated', () => {
      const snap = snapshotSessionState('uuid-a', context, 1_700_000_000_000)
      expect(snap.version).toBe(SESSION_STATE_VERSION)
      expect(snap.updatedAt).toBe(1_700_000_000_000)
    })
  })
})
