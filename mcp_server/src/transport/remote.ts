import type { ConvexClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { anyApi } from 'convex/server'

import type { ParsedMessage } from '../types.js'
import {
  BROKER_UUID_PATTERN,
  DmDeliveryError,
  TopicNameConflictError,
  type Transport,
  type TransportChannel,
  type TransportSession,
  type TransportTopic,
  type TransportTopicMessage,
} from './index.js'

/**
 * Runtime-typed references to the Convex backend's mutations and
 * queries. The local stdio MCP server lives outside the Convex
 * deployment's own `_generated` tree (it ships in an npm package), so we
 * can't import those types directly; `anyApi` is the idiomatic way to
 * call into a user-supplied deployment from library code. The cast
 * through `unknown` is required because `AnyApi`'s shape is much wider
 * than what we're selecting here.
 */
const REF = anyApi as unknown as {
  sessions: {
    mutations: { introduce: unknown; updateLastSeen: unknown; remove: unknown }
    queries: { whoami: unknown; listByChannel: unknown }
  }
  channels: {
    mutations: { join: unknown; leave: unknown }
    queries: { listAll: unknown; listForUser: unknown }
  }
  topics: {
    mutations: { start: unknown; join: unknown; leave: unknown; archive: unknown; unarchive: unknown }
    queries: { listByChannel: unknown; getById: unknown; listJoinedForUser: unknown }
  }
  messages: {
    mutations: { sendToChannel: unknown; sendToTopic: unknown; sendToSession: unknown; ackChannel: unknown }
    queries: { listByTopic: unknown; listByChannel: unknown; listDirectMessagesForSession: unknown }
  }
}

function fn<K extends 'query' | 'mutation' | 'action'>(target: unknown): FunctionReference<K> {
  return target as FunctionReference<K>
}

/**
 * Degradation policy: flip the `enabled` switch when three operations
 * fail within this window, or immediately on any "function not found"
 * error (schema drift). Short window so a transient blip recovers fast
 * but doesn't cascade.
 */
const DEGRADATION_WINDOW_MS = 60_000
const DEGRADATION_THRESHOLD = 3

/**
 * Per-subscription cap on the message-id dedup set. Each `onUpdate` call
 * hands us the full set of rows matching the current `sinceTs` window, so
 * the dedup set grows as messages accumulate within the window. 10k entries
 * bound the memory at ~1MB worst case while covering a very busy topic
 * for a multi-hour session.
 */
const DEDUP_CAPACITY = 10_000

/**
 * Bounded FIFO id-set used to dedupe already-delivered messages across the
 * lifetime of a single subscription. Per-`_id` lookups are O(1); eviction
 * is O(1) amortised. Grows monotonically until it hits `capacity`, then
 * evicts the oldest insertion first.
 */
class BoundedIdSet {
  private readonly ids = new Set<string>()
  private readonly order: string[] = []
  constructor(private readonly capacity: number) {}
  has(id: string): boolean {
    return this.ids.has(id)
  }
  add(id: string): void {
    if (this.ids.has(id)) return
    this.ids.add(id)
    this.order.push(id)
    while (this.order.length > this.capacity) {
      const evicted = this.order.shift()
      if (evicted !== undefined) this.ids.delete(evicted)
    }
  }
}

/**
 * Remote transport: wraps a `ConvexClient` and maps the cccollab
 * `Transport` interface onto the remote deployment's mutations +
 * queries.
 *
 * Design: channels at the remote Convex deployment live in a disjoint
 * namespace from local broker channels. A "dev" channel at the broker
 * and a "dev" channel on the Convex side are two distinct channels;
 * clients route to them by supplying `location: "local"` or
 * `location: "remote"` to the appropriate tool. Topic ids are likewise
 * never shared: local ids are RFC 4122 UUIDs (broker-issued), remote
 * ids are Convex `Id<'topics'>` strings (base32-ish). `hasTopic` uses
 * that shape distinction to dispatch topic-addressed tools.
 *
 * Graceful degradation: on a `FunctionNotFoundError` or 3+ failed
 * operations within `DEGRADATION_WINDOW_MS` we set `enabled = false`
 * and record the reason. Callers in `server.ts` check `enabled`
 * before dispatching. The transport does NOT auto-recover; a session
 * restart or successful `authenticate` is required.
 */
export class RemoteTransport implements Transport {
  readonly source: string
  enabled = true

  private readonly client: ConvexClient
  private sessionId: string | null = null
  private readonly recentFailures: number[] = []
  private degradationReason: string | null = null
  private readonly log: (message: string) => void
  /** True once `shutdown()` has started. Subsequent shutdowns are no-ops;
   *  subsequent subscribe calls return a no-op unsubscribe. */
  private shutdownStarted = false
  /** Every unsubscribe callback returned by this transport's own
   *  `subscribe*` methods. On shutdown we invoke all of them before
   *  closing the underlying ConvexClient so no callback is still in
   *  flight when the websocket disappears. DM unsubscribes handed out
   *  to `server.ts`'s shared list are ALSO tracked here so a `shutdown()`
   *  call is sufficient even if the caller forgets the external list. */
  private readonly trackedUnsubscribes = new Set<() => void>()

  /** Topic ids we've seen from the remote backend (via listJoinedForUser
   *  at startup, plus any we subsequently joined/created). Used by
   *  `hasTopic` to answer "does this id belong to me" without a Convex
   *  roundtrip every dispatch. The set is a soft cache only - the
   *  source of truth lives server-side. */
  private readonly knownTopicIds = new Set<string>()

  /** Highest `ts` (epoch ms) we've delivered to callers per topic. Used
   *  to pass `sinceTs` to the reactive `listByTopic` query so the Convex
   *  server side narrows results rather than replaying full topic
   *  history on every subscribe. Persists across subscribe/unsubscribe
   *  cycles so a reconnect after `leaveTopic`-then-`joinTopic` still
   *  benefits from the narrower window. */
  private readonly topicMaxTs = new Map<string, number>()

  /** Resolved Convex `Id<'channels'>` per channel name. Populated as a
   *  side-effect of `joinChannel` (whose mutation returns the id) so
   *  subsequent `subscribeChannelMessages` calls don't need an extra
   *  lookup round-trip. A channel whose id is unknown falls back to a
   *  `channels.queries.listAll` lookup on demand. */
  private readonly channelIdsByName = new Map<string, string>()

  /** Highest `ts` per channel id. Mirrors `topicMaxTs` - seeds the
   *  reactive `listByChannel` query's `sinceTs` so the initial batch
   *  doesn't replay pre-subscribe broadcasts. */
  private readonly channelMaxTs = new Map<string, number>()

  constructor(opts: { client: ConvexClient; source?: string; log?: (m: string) => void }) {
    this.client = opts.client
    this.source = opts.source ?? 'remote'
    this.log = opts.log ?? ((m) => process.stderr.write(`[cccollab.${this.source}] ${m}\n`))
  }

  /** Human-readable reason the transport self-disabled, or null. */
  get degradation(): string | null {
    return this.degradationReason
  }

  /**
   * Seed the per-topic `sinceTs` cursor so the next `subscribeTopicMessages`
   * call starts the reactive query past this ts.
   *
   * Callers use this immediately before subscribing to a topic whose history
   * has already been delivered to the user (e.g. via `joinTopic`'s history
   * field) to prevent the initial `onUpdate` batch from flooding
   * `MessageBus` with every pre-existing message. The cursor is monotonic
   * non-decreasing: lower values are ignored so a subsequent `joinTopic`
   * reconnect can't regress it.
   */
  primeTopicCursor(topicId: string, ts: number): void {
    const prior = this.topicMaxTs.get(topicId) ?? 0
    if (ts > prior) this.topicMaxTs.set(topicId, ts)
  }

  /**
   * A topic id is ours when it is NOT a broker UUID. We also consult a
   * positive-cache set so ids we've handled are fast-answered even if
   * Convex ever issues a UUID-shaped id in the future. A broker UUID
   * is NEVER ours - that heuristic is load-bearing and intentional.
   */
  hasTopic(topicId: string): boolean {
    if (this.knownTopicIds.has(topicId)) return true
    return !BROKER_UUID_PATTERN.test(topicId)
  }

  // ─── Identity ─────────────────────────────────────────────────────────
  /**
   * Register the session with the remote backend. Unlike the tool-dispatch
   * mutations below (joinChannel, leaveTopic, sendTopicMessage, ...) which
   * swallow errors and degrade the transport silently, `introduce` RETHROWS
   * on failure so `attach.ts`'s "abort before registering" safety contract
   * holds. Callers that need a best-effort introduce should catch the
   * rethrow themselves.
   *
   * `registerFailure` still runs on the way out so the circuit breaker
   * counts this against the failure window — a transient blip at startup
   * is a failure just like one mid-session.
   */
  async introduce(args: { sessionName: string; objective?: string }): Promise<void> {
    if (!this.enabled) {
      throw new Error('remote transport is disabled; cannot introduce')
    }
    try {
      const id = (await this.client.mutation(fn<'mutation'>(REF.sessions.mutations.introduce), {
        sessionName: args.sessionName,
        objective: args.objective,
      })) as string
      this.sessionId = id
      // Preload the topic-id cache so `hasTopic` answers correctly on
      // subsequent tool dispatches for topics we previously joined.
      try {
        const topics = (await this.client.query(fn<'query'>(REF.topics.queries.listJoinedForUser), {})) as Array<{
          _id: string
        }>
        for (const t of topics) this.knownTopicIds.add(t._id)
      } catch {
        // Best-effort hydration; failure is non-fatal.
      }
    } catch (err) {
      this.registerFailure('introduce', err)
      throw err
    }
  }

  // ─── Channels ─────────────────────────────────────────────────────────
  async joinChannel(args: { sessionName: string; channel: string }): Promise<{ subscriberCount: number }> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return { subscriberCount: 0 }
    try {
      const res = (await this.client.mutation(fn<'mutation'>(REF.channels.mutations.join), {
        sessionId: this.sessionId,
        channel: args.channel,
      })) as { channelId?: string }
      if (typeof res?.channelId === 'string') {
        this.channelIdsByName.set(args.channel, res.channelId)
      }
      return { subscriberCount: 0 }
    } catch (err) {
      this.registerFailure('joinChannel', err)
      return { subscriberCount: 0 }
    }
  }

  async leaveChannel(args: { sessionName: string; channel: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(REF.channels.mutations.leave), {
        sessionId: this.sessionId,
        channel: args.channel,
      })
    } catch (err) {
      this.registerFailure('leaveChannel', err)
    }
  }

  async listChannels(args: { sessionName?: string }): Promise<TransportChannel[]> {
    void args
    if (!this.enabled) return []
    try {
      const rows = (await this.client.query(fn<'query'>(REF.channels.queries.listAll), {})) as Array<{
        name: string
        subscriberCount: number
      }>
      return rows.map((r) => ({ name: r.name, subscriberCount: r.subscriberCount }))
    } catch (err) {
      this.registerFailure('listChannels', err)
      return []
    }
  }

  async broadcast(args: { sessionName: string; channel: string; text: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(REF.messages.mutations.sendToChannel), {
        sessionId: this.sessionId,
        channel: args.channel,
        text: args.text,
      })
    } catch (err) {
      this.registerFailure('broadcast', err)
    }
  }

  // ─── Topics ───────────────────────────────────────────────────────────
  async createTopic(args: { sessionName: string; channel: string; topic: string }): Promise<TransportTopic> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) {
      throw new Error('Remote transport not ready; cannot create topic.')
    }
    try {
      const res = (await this.client.mutation(fn<'mutation'>(REF.topics.mutations.start), {
        sessionId: this.sessionId,
        channel: args.channel,
        topic: args.topic,
      })) as { topicId: string; name: string; state: 'active' }
      this.knownTopicIds.add(res.topicId)
      return {
        id: res.topicId,
        topic: res.name,
        channel: args.channel,
        creator: args.sessionName,
        state: res.state,
        createdAt: new Date().toISOString(),
      }
    } catch (err) {
      const code = extractConvexErrorCode(err)
      if (code === 'TOPIC_NAME_CONFLICT') {
        throw new TopicNameConflictError(extractConvexErrorMessage(err))
      }
      this.registerFailure('createTopic', err)
      throw err
    }
  }

  async listTopics(args: {
    sessionName?: string
    channel?: string
    includeArchived?: boolean
  }): Promise<TransportTopic[]> {
    void args.sessionName
    if (!this.enabled) return []
    // Without a channel we have no efficient way to enumerate all
    // topics server-side: `listByChannel` needs a channel name. The
    // router always passes a channel for remote topic listings, so
    // this is fine; if no channel is supplied we return empty.
    if (!args.channel) return []
    try {
      const rows = (await this.client.query(fn<'query'>(REF.topics.queries.listByChannel), {
        channel: args.channel,
        includeArchived: args.includeArchived,
      })) as Array<{
        topicId: string
        name: string
        state: string
        creatorSessionId: string
        createdAt: number
      }>
      for (const r of rows) this.knownTopicIds.add(r.topicId)
      return rows.map((r) => ({
        id: r.topicId,
        topic: r.name,
        channel: args.channel ?? '',
        creator: r.creatorSessionId,
        state: r.state,
        createdAt: new Date(r.createdAt).toISOString(),
        messageCount: undefined,
      }))
    } catch (err) {
      this.registerFailure('listTopics', err)
      return []
    }
  }

  async getTopicById(args: { sessionName: string; topicId: string }): Promise<TransportTopic | null> {
    void args.sessionName
    if (!this.enabled) return null
    if (BROKER_UUID_PATTERN.test(args.topicId)) return null
    try {
      const doc = (await this.client.query(fn<'query'>(REF.topics.queries.getById), {
        topicId: args.topicId,
      })) as {
        _id: string
        topic: string
        channelId: string
        state: string
        creatorSessionId: string
        createdAt: number
      }
      this.knownTopicIds.add(doc._id)
      // Resolve channelId → name so the tool layer receives the
      // user-facing channel string it expects. listAll is short in
      // practice; a future iteration could add a cheaper name-only
      // query.
      const channels = (await this.client.query(fn<'query'>(REF.channels.queries.listAll), {})) as Array<{
        channelId: string
        name: string
      }>
      const parent = channels.find((c) => c.channelId === doc.channelId)
      return {
        id: doc._id,
        topic: doc.topic,
        channel: parent?.name ?? '',
        creator: doc.creatorSessionId,
        state: doc.state,
        createdAt: new Date(doc.createdAt).toISOString(),
      }
    } catch (err) {
      this.registerFailure('getTopicById', err)
      return null
    }
  }

  async joinTopic(args: {
    sessionName: string
    topicId: string
  }): Promise<{ channel?: string; history: TransportTopicMessage[] }> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return { history: [] }
    try {
      const res = (await this.client.mutation(fn<'mutation'>(REF.topics.mutations.join), {
        sessionId: this.sessionId,
        topicId: args.topicId,
      })) as { topicId: string; channelId: string; name: string }
      this.knownTopicIds.add(res.topicId)
      const rows = (await this.client.query(fn<'query'>(REF.messages.queries.listByTopic), {
        topicId: args.topicId,
      })) as Array<{ fromSessionId: string; text: string; ts: number }>
      return {
        history: rows.map((r) => ({
          sender: r.fromSessionId,
          text: r.text,
          ts: new Date(r.ts).toISOString(),
        })),
      }
    } catch (err) {
      this.registerFailure('joinTopic', err)
      return { history: [] }
    }
  }

  async leaveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(REF.topics.mutations.leave), {
        sessionId: this.sessionId,
        topicId: args.topicId,
      })
    } catch (err) {
      this.registerFailure('leaveTopic', err)
    }
  }

  async archiveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(REF.topics.mutations.archive), {
        sessionId: this.sessionId,
        topicId: args.topicId,
      })
    } catch (err) {
      this.registerFailure('archiveTopic', err)
    }
  }

  async unarchiveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(REF.topics.mutations.unarchive), {
        sessionId: this.sessionId,
        topicId: args.topicId,
      })
    } catch (err) {
      const code = extractConvexErrorCode(err)
      if (code === 'TOPIC_NAME_CONFLICT') {
        throw new TopicNameConflictError(extractConvexErrorMessage(err))
      }
      this.registerFailure('unarchiveTopic', err)
    }
  }

  async sendTopicMessage(args: { sessionName: string; topicId: string; text: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(REF.messages.mutations.sendToTopic), {
        sessionId: this.sessionId,
        topicId: args.topicId,
        text: args.text,
      })
    } catch (err) {
      this.registerFailure('sendTopicMessage', err)
    }
  }

  // ─── Sessions & DMs ───────────────────────────────────────────────────
  async listSessions(args: { channel?: string }): Promise<TransportSession[]> {
    if (!this.enabled) return []
    try {
      const rows = (await this.client.query(fn<'query'>(REF.sessions.queries.listByChannel), {
        channel: args.channel,
      })) as Array<{
        _id: string
        sessionName: string
        objective?: string
        machine?: string
        createdAt: number
      }>
      return rows.map((r) => ({
        name: r.sessionName,
        objective: r.objective,
        machine: r.machine,
        // listByChannel doesn't denormalize channel memberships per
        // session today; leave empty so the shape stays stable.
        channels: [],
        registeredAt: new Date(r.createdAt).toISOString(),
      }))
    } catch (err) {
      this.registerFailure('listSessions', err)
      return []
    }
  }

  async sendDirectMessage(args: {
    fromSessionName: string
    toSessionName: string
    text: string
  }): Promise<{ viaChannel?: string }> {
    void args.fromSessionName
    if (!this.enabled || this.sessionId === null) return {}
    try {
      await this.client.mutation(fn<'mutation'>(REF.messages.mutations.sendToSession), {
        sessionId: this.sessionId,
        toSessionName: args.toSessionName,
        text: args.text,
      })
      return {}
    } catch (err) {
      const code = extractConvexErrorCode(err)
      if (code === 'DM_NO_SHARED_CHANNEL' || code === 'DM_RECIPIENT_NOT_FOUND' || code === 'DM_RECIPIENT_AMBIGUOUS') {
        throw new DmDeliveryError(extractConvexErrorMessage(err))
      }
      this.registerFailure('sendDirectMessage', err)
      return {}
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────
  async deregisterSession(args: { sessionName: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(REF.sessions.mutations.remove), {
        sessionId: this.sessionId,
      })
    } catch {
      // best-effort on shutdown; nothing to do
    }
  }

  // ─── Inbound subscriptions ────────────────────────────────────────────

  /**
   * Subscribe to the current session's DM inbox and push each new
   * message into `onEvent`. Idempotent: returns an unsubscribe fn.
   */
  subscribeDirectMessages(onEvent: (msg: ParsedMessage) => void): () => void {
    if (this.sessionId === null || this.shutdownStarted) return () => {}
    // Per-subscription id dedup. Necessary because Convex's `ts` has
    // millisecond resolution and two DMs inserted in the same mutation
    // share a `ts` — filtering on `row.ts <= lastTs` would drop the
    // second one. See convex/messages/queries.ts for the matching
    // inclusive cursor on the server side.
    const seen = new BoundedIdSet(DEDUP_CAPACITY)
    const ownSessionId = this.sessionId
    const rawUnsubscribe = this.client.onUpdate(
      fn<'query'>(REF.messages.queries.listDirectMessagesForSession),
      { sessionId: this.sessionId },
      (rows) => {
        const arr = rows as Array<{
          _id: string
          fromSessionId: string
          text: string
          ts: number
          channelId?: string
        }>
        for (const row of arr) {
          if (seen.has(row._id)) continue
          seen.add(row._id)
          // Skip self-echo: messages this session sent shouldn't push back
          // into our own Claude as `<channel>` tags. Mirrors the local
          // broker's `isExactSelf` drop in broker-event-listener.ts.
          if (row.fromSessionId === ownSessionId) continue
          onEvent({
            sender: row.fromSessionId,
            text: row.text,
            ts: new Date(row.ts).toISOString(),
            channel: row.channelId ?? 'direct',
            channelName: row.channelId ?? 'direct',
            threadTs: undefined,
          })
        }
      },
      (err) => {
        this.registerSubscriptionFailure('subscribeDirectMessages', err)
      },
    )
    return this.trackUnsubscribe(() => rawUnsubscribe())
  }

  /**
   * Subscribe to a topic's reactive message feed. Each new message is
   * passed to `onEvent` as a `ParsedMessage` tagged for the remote
   * source by MessageBus when it pushes. Callers are responsible for
   * calling the returned unsubscribe fn on leave/archive/shutdown.
   */
  subscribeTopicMessages(
    args: { topicId: string; channelName: string },
    onEvent: (msg: ParsedMessage) => void,
  ): () => void {
    if (!this.enabled || this.shutdownStarted) return () => {}
    // Narrow the reactive window server-side with the inclusive `sinceTs`
    // cursor (>= rather than >). The dedup happens client-side by `_id`
    // since `ts` alone can collide at millisecond resolution.
    const startingTs = this.topicMaxTs.get(args.topicId)
    const queryArgs: { topicId: string; sinceTs?: number } =
      startingTs === undefined ? { topicId: args.topicId } : { topicId: args.topicId, sinceTs: startingTs }
    const seen = new BoundedIdSet(DEDUP_CAPACITY)
    const ownSessionId = this.sessionId
    const rawUnsubscribe = this.client.onUpdate(
      fn<'query'>(REF.messages.queries.listByTopic),
      queryArgs,
      (rows) => {
        const arr = rows as Array<{ _id: string; fromSessionId: string; text: string; ts: number }>
        for (const row of arr) {
          if (seen.has(row._id)) continue
          seen.add(row._id)
          const prior = this.topicMaxTs.get(args.topicId) ?? 0
          if (row.ts > prior) this.topicMaxTs.set(args.topicId, row.ts)
          // Skip self-echo: messages this session just sent shouldn't push
          // back into our own Claude. The cursor advance above still
          // happens so the next reconnect doesn't re-deliver our own row.
          // Mirrors the local broker's `isExactSelf` drop.
          if (row.fromSessionId === ownSessionId) continue
          onEvent({
            sender: row.fromSessionId,
            text: row.text,
            ts: new Date(row.ts).toISOString(),
            channel: args.channelName,
            channelName: args.channelName,
            threadTs: args.topicId,
          })
        }
      },
      (err) => {
        this.registerSubscriptionFailure('subscribeTopicMessages', err)
      },
    )
    return this.trackUnsubscribe(() => rawUnsubscribe())
  }

  /**
   * Subscribe to a channel's reactive broadcast feed. Each new message is
   * passed to `onEvent` as a `ParsedMessage` that MessageBus tags for the
   * remote source when it pushes. Symmetric to `subscribeTopicMessages`
   * but addressed by channel name (resolved to a Convex `Id<'channels'>`
   * via the `joinChannel` mutation's returned `channelId`, with a
   * `channels.queries.listAll` fallback when the id isn't cached).
   *
   * Callers are responsible for invoking the returned unsubscribe fn on
   * `leave_channel` / shutdown; tracked internally via `trackUnsubscribe`
   * so a `shutdown()` still sweeps it if the caller drops the reference.
   */
  subscribeChannelMessages(args: { channelName: string }, onEvent: (msg: ParsedMessage) => void): () => void {
    if (!this.enabled || this.shutdownStarted) return () => {}
    const seen = new BoundedIdSet(DEDUP_CAPACITY)

    // Resolve the channel id. If we have it cached from a prior
    // joinChannel, use it synchronously; otherwise kick off an async
    // listAll lookup, then register the subscription once the id lands.
    // The outer return type stays synchronous so callers can treat this
    // identically to subscribeTopicMessages.
    let innerUnsubscribe: (() => void) | null = null
    let unsubscribed = false

    const register = (channelId: string): void => {
      if (unsubscribed) return
      const sessionId = this.sessionId
      // Without a sessionId we can't use the server-side cursor; fall
      // back to no filtering. Practically attachLocation introduces
      // before subscribing, so sessionId is always set here - but we
      // don't want to hard-fail if the order is ever violated.
      const queryArgs: { channelId: string; sessionId?: string; sinceTs?: number } =
        sessionId !== null ? { channelId, sessionId } : { channelId }
      innerUnsubscribe = this.client.onUpdate(
        fn<'query'>(REF.messages.queries.listByChannel),
        queryArgs,
        (rows) => {
          const arr = rows as Array<{ _id: string; fromSessionId: string; text: string; ts: number }>
          let highestTsInBatch = 0
          for (const row of arr) {
            if (seen.has(row._id)) continue
            seen.add(row._id)
            const prior = this.channelMaxTs.get(channelId) ?? 0
            if (row.ts > prior) this.channelMaxTs.set(channelId, row.ts)
            if (row.ts > highestTsInBatch) highestTsInBatch = row.ts
            // Skip self-echo: own broadcasts shouldn't push back to our
            // own Claude. Cursor + ack advance above still happens so
            // we don't re-deliver our own row on reconnect. Mirrors the
            // local broker's self-broadcast drop.
            if (sessionId !== null && row.fromSessionId === sessionId) continue
            onEvent({
              sender: row.fromSessionId,
              text: row.text,
              ts: new Date(row.ts).toISOString(),
              channel: args.channelName,
              channelName: args.channelName,
              threadTs: undefined,
            })
          }
          // Ack the batch's highest ts so subsequent subscribes (incl.
          // MCP restarts) skip re-delivering it. Fire-and-forget; a
          // failure here is non-fatal - the NEXT successful ack bumps
          // the cursor to cover this batch's ts too (acks are monotonic
          // and idempotent).
          //
          // Critically: ack failures MUST NOT trip the degradation
          // circuit. A transient UNAUTHENTICATED during auth-refresh or
          // a server hiccup on a fire-and-forget call would otherwise
          // kill the whole transport for the session. The reactive
          // listByChannel subscription's own error path still degrades
          // on persistent failure, which is the right signal.
          if (highestTsInBatch > 0 && sessionId !== null) {
            void this.client
              .mutation(fn<'mutation'>(REF.messages.mutations.ackChannel), {
                sessionId,
                channelId,
                ts: highestTsInBatch,
              })
              .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                this.log(`ackChannel failed (non-fatal, cursor will advance on next ack): ${msg}`)
              })
          }
        },
        (err) => {
          this.registerSubscriptionFailure('subscribeChannelMessages', err)
        },
      )
    }

    const cached = this.channelIdsByName.get(args.channelName)
    if (cached !== undefined) {
      register(cached)
    } else {
      void (async () => {
        try {
          const rows = (await this.client.query(fn<'query'>(REF.channels.queries.listAll), {})) as Array<{
            channelId: string
            name: string
          }>
          const match = rows.find((r) => r.name.toLowerCase() === args.channelName.toLowerCase())
          if (match !== undefined) {
            this.channelIdsByName.set(args.channelName, match.channelId)
            register(match.channelId)
          }
        } catch (err) {
          this.registerFailure('subscribeChannelMessages.lookup', err)
        }
      })()
    }

    return this.trackUnsubscribe(() => {
      unsubscribed = true
      if (innerUnsubscribe !== null) {
        try {
          innerUnsubscribe()
        } catch {
          /* best-effort */
        }
        innerUnsubscribe = null
      }
    })
  }

  /**
   * Seed the per-channel `sinceTs` cursor (by channel id) so the next
   * `subscribeChannelMessages` call skips broadcasts older than `ts`.
   * No-op if the channel name hasn't been resolved yet.
   */
  primeChannelCursor(channelName: string, ts: number): void {
    const channelId = this.channelIdsByName.get(channelName)
    if (channelId === undefined) return
    const prior = this.channelMaxTs.get(channelId) ?? 0
    if (ts > prior) this.channelMaxTs.set(channelId, ts)
  }

  /**
   * Tear down the transport: invoke every outstanding subscribe-returned
   * unsubscribe (DMs, topics, anything else future code adds via
   * `trackUnsubscribe`), then close the underlying ConvexClient so its
   * websocket shuts down. Safe to call multiple times; subsequent calls
   * are no-ops.
   *
   * Used by `attachLocation`'s replace-in-place path (e.g. a force
   * re-authenticate of an already-live location) and by the process-wide
   * shutdown hook in `server.ts`. Never throws; errors from inner
   * `.close()` or individual unsubscribe fns are swallowed after being
   * logged so a cleanup failure cannot cascade into a stuck shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownStarted) return
    this.shutdownStarted = true
    this.enabled = false
    for (const unsub of this.trackedUnsubscribes) {
      try {
        unsub()
      } catch (err) {
        this.log(`shutdown: unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.trackedUnsubscribes.clear()
    try {
      await this.client.close()
    } catch (err) {
      this.log(`shutdown: client.close() failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Wrap an unsubscribe callback so (a) it only runs once, (b) calling
   * it removes the entry from `trackedUnsubscribes`. Callers hand the
   * returned fn out - e.g. to `server.ts`'s `remoteUnsubscribes` map -
   * and `shutdown()` still catches it via the internal set.
   */
  private trackUnsubscribe(fn: () => void): () => void {
    let invoked = false
    const wrapped = (): void => {
      if (invoked) return
      invoked = true
      this.trackedUnsubscribes.delete(wrapped)
      try {
        fn()
      } catch (err) {
        this.log(`unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.trackedUnsubscribes.add(wrapped)
    return wrapped
  }

  // ─── internals ────────────────────────────────────────────────────────

  /**
   * Register a transient failure from a long-lived reactive subscription
   * error callback. Unlike `registerFailure`, this variant does NOT
   * immediately disable the transport on UNAUTHENTICATED because the
   * underlying `ConvexClient` routinely retries with a refreshed token
   * during the auth handshake window at startup. Only
   * function-not-found (structural schema drift) and the sustained
   * count-in-window path trip the breaker here.
   */
  private registerSubscriptionFailure(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.log(`subscription ${op} error (transient): ${msg}`)
    if (isFunctionNotFoundError(err)) {
      this.enabled = false
      this.degradationReason = `Remote sync disabled: function not found on deployment (${msg})`
      this.log(this.degradationReason)
      return
    }
    // Intentionally NOT tripping on isAuthError: a single
    // UNAUTHENTICATED during startup auth-refresh must not kill the
    // whole transport. Persistent auth failures still surface via the
    // mutation/query paths which use `registerFailure`.
    const now = Date.now()
    this.recentFailures.push(now)
    while (this.recentFailures.length > 0 && now - this.recentFailures[0]! > DEGRADATION_WINDOW_MS) {
      this.recentFailures.shift()
    }
    if (this.recentFailures.length >= DEGRADATION_THRESHOLD) {
      this.enabled = false
      this.degradationReason = `Remote sync disabled: ${this.recentFailures.length} subscription failures within ${DEGRADATION_WINDOW_MS}ms (last: ${msg})`
      this.log(this.degradationReason)
    }
  }

  private registerFailure(op: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.log(`op ${op} failed: ${msg}`)

    if (isFunctionNotFoundError(err)) {
      this.enabled = false
      this.degradationReason = `Remote sync disabled: function not found on deployment (${msg})`
      this.log(this.degradationReason)
      return
    }

    if (isAuthError(err)) {
      this.enabled = false
      this.degradationReason = `Remote sync disabled: authentication failed (${msg})`
      this.log(this.degradationReason)
      return
    }

    const now = Date.now()
    this.recentFailures.push(now)
    while (this.recentFailures.length > 0 && now - this.recentFailures[0]! > DEGRADATION_WINDOW_MS) {
      this.recentFailures.shift()
    }
    if (this.recentFailures.length >= DEGRADATION_THRESHOLD) {
      this.enabled = false
      this.degradationReason = `Remote sync disabled: ${this.recentFailures.length} failures within ${DEGRADATION_WINDOW_MS}ms (last: ${msg})`
      this.log(this.degradationReason)
    }
  }
}

/** Convex `ConvexError` serialises its structured data into the error's
 *  `data` field. Fall back to message parsing for other errors. */
function extractConvexErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    const data = (err as { data: unknown }).data
    if (typeof data === 'object' && data !== null && 'code' in data) {
      const code = (data as { code: unknown }).code
      if (typeof code === 'string') return code
    }
  }
  return null
}

function extractConvexErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    const data = (err as { data: unknown }).data
    if (typeof data === 'object' && data !== null && 'message' in data) {
      const message = (data as { message: unknown }).message
      if (typeof message === 'string') return message
    }
  }
  return err instanceof Error ? err.message : String(err)
}

function isFunctionNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const name = err.name
  const msg = err.message
  return name === 'FunctionNotFoundError' || /Could not find.*function/i.test(msg) || /function not found/i.test(msg)
}

/**
 * Detect whether an error thrown by the Convex client reflects an
 * authentication failure. Prefer structured signals; fall back to
 * message parsing only as a last resort.
 *
 * Our Convex backend throws `ConvexError({code: 'UNAUTHENTICATED', ...})`
 * via the `authenticatedQuery` / `authenticatedMutation` wrappers
 * (`convex/utils/auth.ts`), which serialises to the client as
 * `err.data.code === 'UNAUTHENTICATED'`. That is the stable signal.
 * Some Convex Auth paths surface an `UnauthenticatedError` name on the
 * Error object - check that too. The string pattern is kept as a third
 * safety net for auth failures that escape via raw messages.
 */
function isAuthError(err: unknown): boolean {
  if (extractConvexErrorCode(err) === 'UNAUTHENTICATED') return true
  if (err instanceof Error && err.name === 'UnauthenticatedError') return true
  if (err instanceof Error && /unauthenticated|not signed in|invalid token|expired/i.test(err.message)) {
    return true
  }
  return false
}
