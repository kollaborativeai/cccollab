import type { ConvexClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { anyApi } from 'convex/server'

import type { ParsedMessage } from '../types.js'
import { normalizeChannelName } from '../context.js'
import {
  BROKER_UUID_PATTERN,
  TopicNameConflictError,
  type Transport,
  type TransportChannel,
  type TransportHistoryPage,
  type TransportSession,
  type TransportTopic,
  type TransportTopicMessage,
} from './index.js'

/**
 * Shape of function-reference paths for the remote deployment.
 * The {mutations, queries} segments are retained for code-organization
 * clarity; clerk authType populates both from the flat api.cccollab.X
 * path.
 */
export type Refs = {
  sessions: {
    mutations: {
      introduce: FunctionReference<'query' | 'mutation' | 'action'>
      updateLastSeen: FunctionReference<'query' | 'mutation' | 'action'>
      remove: FunctionReference<'query' | 'mutation' | 'action'>
    }
    queries: {
      whoami: FunctionReference<'query' | 'mutation' | 'action'>
      listByChannel: FunctionReference<'query' | 'mutation' | 'action'>
      getSessionContext: FunctionReference<'query' | 'mutation' | 'action'>
    }
  }
  channels: {
    mutations: {
      join: FunctionReference<'query' | 'mutation' | 'action'>
      leave: FunctionReference<'query' | 'mutation' | 'action'>
    }
    queries: {
      listAll: FunctionReference<'query' | 'mutation' | 'action'>
      listForUser: FunctionReference<'query' | 'mutation' | 'action'>
    }
  }
  topics: {
    mutations: {
      start: FunctionReference<'query' | 'mutation' | 'action'>
      join: FunctionReference<'query' | 'mutation' | 'action'>
      leave: FunctionReference<'query' | 'mutation' | 'action'>
      archive: FunctionReference<'query' | 'mutation' | 'action'>
      unarchive: FunctionReference<'query' | 'mutation' | 'action'>
    }
    queries: {
      listByChannel: FunctionReference<'query' | 'mutation' | 'action'>
      getById: FunctionReference<'query' | 'mutation' | 'action'>
      listJoinedForUser: FunctionReference<'query' | 'mutation' | 'action'>
    }
  }
  messages: {
    mutations: {
      sendToChannel: FunctionReference<'query' | 'mutation' | 'action'>
      sendToTopic: FunctionReference<'query' | 'mutation' | 'action'>
      ackChannel: FunctionReference<'query' | 'mutation' | 'action'>
    }
    queries: {
      listByTopic: FunctionReference<'query' | 'mutation' | 'action'>
      listByChannel: FunctionReference<'query' | 'mutation' | 'action'>
      readChannelHistory: FunctionReference<'query' | 'mutation' | 'action'>
      readTopicHistory: FunctionReference<'query' | 'mutation' | 'action'>
    }
  }
  organizations: {
    queries: {
      listForUser: FunctionReference<'query' | 'mutation' | 'action'>
    }
  }
}

/**
 * Build function-reference paths for KAI's deployment.
 *
 * KAI namespaces every callable under `cccollab/*` and flattens the
 * queries/mutations directory split, so each operation lives at
 * `api.cccollab.<area>.<op>`. We keep the {mutations, queries} segments
 * on the internal type for code-organization clarity even though both
 * draw from the same flat path.
 */
export function makeRefs(): Refs {
  const c = (
    anyApi as unknown as {
      cccollab: {
        sessions: {
          introduce: FunctionReference<'query' | 'mutation' | 'action'>
          updateLastSeen: FunctionReference<'query' | 'mutation' | 'action'>
          remove: FunctionReference<'query' | 'mutation' | 'action'>
          whoami: FunctionReference<'query' | 'mutation' | 'action'>
          listByChannel: FunctionReference<'query' | 'mutation' | 'action'>
          getSessionContext: FunctionReference<'query' | 'mutation' | 'action'>
        }
        channels: {
          join: FunctionReference<'query' | 'mutation' | 'action'>
          leave: FunctionReference<'query' | 'mutation' | 'action'>
          listAll: FunctionReference<'query' | 'mutation' | 'action'>
          listForUser: FunctionReference<'query' | 'mutation' | 'action'>
        }
        topics: {
          start: FunctionReference<'query' | 'mutation' | 'action'>
          join: FunctionReference<'query' | 'mutation' | 'action'>
          leave: FunctionReference<'query' | 'mutation' | 'action'>
          archive: FunctionReference<'query' | 'mutation' | 'action'>
          unarchive: FunctionReference<'query' | 'mutation' | 'action'>
          listByChannel: FunctionReference<'query' | 'mutation' | 'action'>
          getById: FunctionReference<'query' | 'mutation' | 'action'>
          listJoinedForSession: FunctionReference<'query' | 'mutation' | 'action'>
        }
        messages: {
          sendToChannel: FunctionReference<'query' | 'mutation' | 'action'>
          sendToTopic: FunctionReference<'query' | 'mutation' | 'action'>
          ackChannel: FunctionReference<'query' | 'mutation' | 'action'>
          listByTopic: FunctionReference<'query' | 'mutation' | 'action'>
          listByChannel: FunctionReference<'query' | 'mutation' | 'action'>
          readChannelHistory: FunctionReference<'query' | 'mutation' | 'action'>
          readTopicHistory: FunctionReference<'query' | 'mutation' | 'action'>
        }
        organizations: {
          listForUser: FunctionReference<'query' | 'mutation' | 'action'>
        }
      }
    }
  ).cccollab
  return {
    sessions: {
      mutations: {
        introduce: c.sessions.introduce,
        updateLastSeen: c.sessions.updateLastSeen,
        remove: c.sessions.remove,
      },
      queries: {
        whoami: c.sessions.whoami,
        listByChannel: c.sessions.listByChannel,
        getSessionContext: c.sessions.getSessionContext,
      },
    },
    channels: {
      mutations: { join: c.channels.join, leave: c.channels.leave },
      queries: { listAll: c.channels.listAll, listForUser: c.channels.listForUser },
    },
    topics: {
      mutations: {
        start: c.topics.start,
        join: c.topics.join,
        leave: c.topics.leave,
        archive: c.topics.archive,
        unarchive: c.topics.unarchive,
      },
      queries: {
        listByChannel: c.topics.listByChannel,
        getById: c.topics.getById,
        listJoinedForUser: c.topics.listJoinedForSession,
      },
    },
    messages: {
      mutations: {
        sendToChannel: c.messages.sendToChannel,
        sendToTopic: c.messages.sendToTopic,
        ackChannel: c.messages.ackChannel,
      },
      queries: {
        listByTopic: c.messages.listByTopic,
        listByChannel: c.messages.listByChannel,
        readChannelHistory: c.messages.readChannelHistory,
        readTopicHistory: c.messages.readTopicHistory,
      },
    },
    organizations: {
      queries: { listForUser: c.organizations.listForUser },
    },
  }
}

function fn<K extends 'query' | 'mutation' | 'action'>(target: unknown): FunctionReference<K> {
  return target as FunctionReference<K>
}

/**
 * A reactive feed the transport owns.
 *
 * `inner` is the detach fn for the live Convex `onUpdate`, or null while
 * suspended. `attached` is the ONLY thing that means "we can actually hear on
 * this feed": a channel feed's `onUpdate` may be registered asynchronously
 * (after a `listAll` id lookup), so `inner` is non-null the instant we subscribe
 * while the real subscription may never attach at all — if the lookup throws or
 * matches nothing, `register()` never runs. Treating a non-null `inner` as
 * healthy is how a silently deaf feed passes for a live one.
 */
interface FeedState {
  onEvent: (msg: ParsedMessage) => void
  inner: (() => void) | null
  /** True only once the inner `onUpdate` has ACTUALLY been registered. */
  attached: boolean
}

interface TopicFeed extends FeedState {
  /** Normalized name of the channel this topic lives in. The backend's
   *  `listByTopic` asserts CHANNEL presence, so leaving the channel must
   *  suspend this feed too. */
  channelName: string
}

type ChannelFeed = FeedState

/**
 * Canonical key for anything addressed by channel NAME.
 *
 * Channel names are case-insensitive end to end (the backend resolves a channel
 * by name within the org, and the `listAll` fallback already matches
 * case-insensitively). Keying the feed registry, the id cache and the cursors
 * on the raw string is what let a `Dev` / `dev` mismatch make a channel look
 * permanently un-subscribed and stack a duplicate feed on every re-introduce.
 * Normalizing at the single point of entry removes that class outright.
 *
 * This is `normalizeChannelName` from the context layer, imported rather than
 * re-implemented: the invariant "transport key == context key" is what keeps the
 * duplicate-feed bug dead, and two private copies of `trim().toLowerCase()` are
 * exactly how it would come back.
 */
const channelKey = normalizeChannelName

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
  private readonly refs: Refs
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
   *  flight when the websocket disappears. Unsubscribes handed out to
   *  `server.ts`'s shared list are ALSO tracked here so a `shutdown()`
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

  /** The organization this transport's session row is currently bound to.
   *  Tracked so `introduce` can tell an org CHANGE (which invalidates every
   *  topic id we hold) from a plain rename. */
  private boundOrganizationId: string | undefined

  /**
   * The live feeds this transport owns, keyed by topic id / normalized channel
   * name. `inner` is the live Convex `onUpdate` unsubscribe, or null when the
   * feed is SUSPENDED — registered but detached, because the identity or
   * membership its query args are bound to is momentarily invalid.
   *
   * This registry is the whole point of KAI-418: the transport, not the tool
   * layer, keeps its feeds in sync with its own state (sessionId, channel ids,
   * cursors). Anything that invalidates a feed suspends it; the join that makes
   * it valid again restores it. A caller cannot forget to do that, because a
   * caller is never asked to.
   */
  private readonly topicFeeds = new Map<string, TopicFeed>()
  private readonly channelFeeds = new Map<string, ChannelFeed>()

  constructor(opts: { client: ConvexClient; source?: string; log?: (m: string) => void }) {
    this.client = opts.client
    this.source = opts.source ?? 'remote'
    this.refs = makeRefs()
    this.log = opts.log ?? ((m) => process.stderr.write(`[cccollab.${this.source}] ${m}\n`))
  }

  /**
   * Merges this session's `sessionId` into a read query's argument object.
   * KAI's queries require the sessionId to resolve the caller's
   * organization. A no-op when no session has been introduced yet.
   */
  private orgScopedArgs(args: Record<string, unknown>): Record<string, unknown> {
    if (this.sessionId !== null) {
      return { ...args, sessionId: this.sessionId }
    }
    return args
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
  async introduce(args: { sessionName: string; objective?: string; organizationId?: string }): Promise<void> {
    if (!this.enabled) {
      throw new Error('remote transport is disabled; cannot introduce')
    }
    const previousSessionId = this.sessionId
    const previousOrganizationId = this.boundOrganizationId
    try {
      const id = (await this.client.mutation(fn<'mutation'>(this.refs.sessions.mutations.introduce), {
        sessionName: args.sessionName,
        objective: args.objective,
        organizationId: args.organizationId,
      })) as string
      this.sessionId = id
      this.boundOrganizationId = args.organizationId

      // The session row REBOUND: every live feed's query args froze the old id,
      // and the backend gates those queries on that id's membership rows. Left
      // running they would deliver nothing at best and throw at worst — so they
      // are suspended here and re-attached by the join* that makes them valid
      // again. We do NOT re-subscribe here: at this moment the memberships have
      // been left and not yet re-joined, so a feed registered now would be
      // gated out. An introduce that does NOT move the session row (same name,
      // same org — the idempotent case) suspends nothing and churns nothing.
      if (previousSessionId !== null && previousSessionId !== id) {
        const orgChanged =
          previousOrganizationId !== undefined &&
          args.organizationId !== undefined &&
          previousOrganizationId !== args.organizationId

        if (orgChanged) {
          // Every topic id we hold belongs to the OLD org: meaningless in the
          // new one, and re-subscribing it would trip the backend's org
          // assertion. Drop those feeds outright rather than suspend them —
          // suspending would leave them pretending forever that the session is
          // deaf on topics that no longer exist for it. Channel feeds only
          // suspend: a channel is addressed by NAME and re-resolves in the new
          // org on the next joinChannel.
          for (const [topicId, feed] of [...this.topicFeeds]) {
            this.topicFeeds.delete(topicId)
            this.detach(feed)
          }
          // The cached ids belong to the old org too.
          this.channelIdsByName.clear()
        } else {
          for (const topicId of this.topicFeeds.keys()) this.suspendTopicFeed(topicId)
        }
        for (const feed of this.channelFeeds.values()) this.detach(feed)
      }

      // Preload the topic-id cache so `hasTopic` answers correctly on
      // subsequent tool dispatches for topics we previously joined.
      try {
        const topics = (await this.client.query(
          fn<'query'>(this.refs.topics.queries.listJoinedForUser),
          this.orgScopedArgs({}),
        )) as Array<{
          _id: string
        }>
        for (const t of topics) this.knownTopicIds.add(t._id)
      } catch {
        /* best-effort preload */
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
      const res = (await this.client.mutation(fn<'mutation'>(this.refs.channels.mutations.join), {
        sessionId: this.sessionId,
        channel: args.channel,
      })) as { channelId?: string; latestTs?: number }
      if (typeof res?.channelId === 'string') {
        this.channelIdsByName.set(channelKey(args.channel), res.channelId)
        // Seed the per-channel cursor ONLY on the first-ever join, to skip
        // pre-join history. A re-join (the identity migration re-joins the
        // channel mid-rename) must NOT touch an existing cursor: the value
        // there is the delivered high-water mark, and advancing it to the
        // channel's current `latestTs` would skip every broadcast that
        // arrived in (delivered, latestTs] because `subscribeChannelMessages`
        // resumes at `sinceTs = channelMaxTs` EXCLUSIVE. Mirrors `joinTopic`,
        // which never clobbers `topicMaxTs`.
        if (typeof res.latestTs === 'number' && !this.channelMaxTs.has(res.channelId)) {
          this.channelMaxTs.set(res.channelId, res.latestTs)
        }
      }
      // The membership row the channel feed's query is gated on now exists, so
      // a feed suspended by a leave or a rebind can go live again — under the
      // CURRENT sessionId and the preserved cursor. Only AFTER a successful
      // join, never before. Topic feeds are NOT restored here: their topic
      // membership may not be back yet; `joinTopic` restores those.
      this.restoreChannelFeed(args.channel)
      return { subscriberCount: 0 }
    } catch (err) {
      this.registerFailure('joinChannel', err)
      return { subscriberCount: 0 }
    }
  }

  async leaveChannel(args: { sessionName: string; channel: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    // Suspend BEFORE the mutation: the instant channel membership goes, a live
    // listByChannel returns nothing and a live listByTopic inside that channel
    // THROWS (it asserts channel presence) — and three such failures disable
    // the whole transport. This also sweeps the topic feeds in the channel.
    this.suspendChannelFeed(args.channel)
    try {
      await this.client.mutation(fn<'mutation'>(this.refs.channels.mutations.leave), {
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
      const rows = (await this.client.query(
        fn<'query'>(this.refs.channels.queries.listAll),
        this.orgScopedArgs({}),
      )) as Array<{
        name: string
        subscriberCount: number
        presentSessionCount?: number
        messageCount?: number
      }>
      return rows.map((r) => ({
        name: r.name,
        subscriberCount: r.subscriberCount,
        // The backend's `listAll` reports `presentSessionCount` — the count of
        // sessions joined to the channel, as distinct from the user-level
        // `subscriberCount`. Surface it as `sessionCount`.
        sessionCount: r.presentSessionCount,
        messageCount: r.messageCount,
      }))
    } catch (err) {
      this.registerFailure('listChannels', err)
      return []
    }
  }

  /**
   * Lists the authenticated user's organizations on KAI's deployment.
   * Backs the `list_organizations` tool.
   */
  async listOrganizations(): Promise<Array<{ id: string; name: string }>> {
    if (!this.enabled) return []
    try {
      return (await this.client.query(fn<'query'>(this.refs.organizations.queries.listForUser), {})) as Array<{
        id: string
        name: string
      }>
    } catch (err) {
      this.registerFailure('listOrganizations', err)
      return []
    }
  }

  /**
   * Returns the name of the organization this transport's session is bound
   * to, or null when no session has been introduced or the lookup fails.
   * Backs the `organization` field of `whoami`.
   *
   * Errors are intentionally swallowed without `registerFailure` — this
   * method backs an informational status surface (`whoami`) that is polled
   * frequently and should never cause the remote transport's circuit
   * breaker to trip on a transient query hiccup.
   */
  /** The org id this transport's session row is bound to, as far as we can
   *  actually know it: the one the last successful `introduce` carried.
   *  (The backend's `getSessionContext` returns only the org NAME, so there is
   *  no way to ask it for the id.) */
  getBoundOrganizationId(): string | undefined {
    return this.boundOrganizationId
  }

  async getBoundOrganizationName(): Promise<string | null> {
    if (!this.enabled || !this.sessionId) return null
    try {
      const ctx = (await this.client.query(fn<'query'>(this.refs.sessions.queries.getSessionContext), {
        sessionId: this.sessionId,
      })) as { organizationName: string }
      return ctx.organizationName
    } catch {
      return null
    }
  }

  async broadcast(args: { sessionName: string; channel: string; text: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(this.refs.messages.mutations.sendToChannel), {
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
      const res = (await this.client.mutation(fn<'mutation'>(this.refs.topics.mutations.start), {
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
      const rows = (await this.client.query(
        fn<'query'>(this.refs.topics.queries.listByChannel),
        this.orgScopedArgs({ channel: args.channel, includeArchived: args.includeArchived }),
      )) as Array<{
        topicId: string
        name: string
        state: string
        creatorSessionId: string
        createdAt: number
        messageCount?: number
        joined?: boolean
      }>
      for (const r of rows) this.knownTopicIds.add(r.topicId)
      return rows.map((r) => ({
        id: r.topicId,
        topic: r.name,
        channel: args.channel ?? '',
        creator: r.creatorSessionId,
        state: r.state,
        createdAt: new Date(r.createdAt).toISOString(),
        messageCount: r.messageCount,
        // The org-scoped backend reports whether this session has joined the
        // topic. Pass it through so `list_topics` reflects the real backend
        // membership rather than only the MCP server's in-memory context.
        joined: r.joined,
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
      const doc = (await this.client.query(
        fn<'query'>(this.refs.topics.queries.getById),
        this.orgScopedArgs({ topicId: args.topicId }),
      )) as {
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
      const channels = (await this.client.query(
        fn<'query'>(this.refs.channels.queries.listAll),
        this.orgScopedArgs({}),
      )) as Array<{
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
      // The Convex backend rejects `getById` with NOT_SUBSCRIBED_TO_CHANNEL
      // (or TOPIC_NOT_FOUND) when the caller has no access — these are
      // expected user-input errors, not transport failures. Treat them as
      // "no such visible topic" so the tool layer surfaces the standard
      // not-found path without tripping the degradation circuit.
      const code = extractConvexErrorCode(err)
      if (code === 'NOT_SUBSCRIBED_TO_CHANNEL' || code === 'TOPIC_NOT_FOUND') {
        return null
      }
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
      const res = (await this.client.mutation(fn<'mutation'>(this.refs.topics.mutations.join), {
        sessionId: this.sessionId,
        topicId: args.topicId,
      })) as { topicId: string; channelId: string; name: string }
      this.knownTopicIds.add(res.topicId)
      const rows = (await this.client.query(
        fn<'query'>(this.refs.messages.queries.listByTopic),
        this.orgScopedArgs({ topicId: args.topicId }),
      )) as Array<{ fromSessionId: string; text: string; ts: number }>
      // Topic membership is back ⇒ a feed suspended by a leave or a rebind can
      // go live again, under the CURRENT sessionId and the preserved cursor.
      this.restoreTopicFeed(args.topicId)
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
    // Suspend BEFORE the mutation — see `leaveChannel`.
    this.suspendTopicFeed(args.topicId)
    try {
      await this.client.mutation(fn<'mutation'>(this.refs.topics.mutations.leave), {
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
      await this.client.mutation(fn<'mutation'>(this.refs.topics.mutations.archive), {
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
      await this.client.mutation(fn<'mutation'>(this.refs.topics.mutations.unarchive), {
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
      await this.client.mutation(fn<'mutation'>(this.refs.messages.mutations.sendToTopic), {
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
      const rows = (await this.client.query(
        fn<'query'>(this.refs.sessions.queries.listByChannel),
        this.orgScopedArgs({ channel: args.channel }),
      )) as Array<{
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

  // ─── Message history ──────────────────────────────────────────────────

  private static toHistoryPage(raw: {
    messages: Array<{ fromSessionId: string; senderSessionName?: string; text: string; ts: number }>
    hasMore: boolean
  }): TransportHistoryPage {
    return {
      messages: raw.messages.map((m) => ({
        sender: m.fromSessionId,
        senderSessionName: m.senderSessionName,
        text: m.text,
        ts: m.ts,
      })),
      hasMore: raw.hasMore,
      oldestTs: raw.messages.length > 0 ? raw.messages[0]!.ts : undefined,
    }
  }

  private async resolveChannelId(channelName: string): Promise<string | null> {
    const key = channelKey(channelName)
    const cached = this.channelIdsByName.get(key)
    if (cached !== undefined) return cached
    try {
      const rows = (await this.client.query(
        fn<'query'>(this.refs.channels.queries.listAll),
        this.orgScopedArgs({}),
      )) as Array<{ channelId: string; name: string }>
      const match = rows.find((r) => channelKey(r.name) === key)
      if (match === undefined) return null
      this.channelIdsByName.set(key, match.channelId)
      return match.channelId
    } catch (err) {
      this.registerFailure('resolveChannelId', err)
      return null
    }
  }

  async readChannelMessages(args: { channel: string; limit?: number; before?: number }): Promise<TransportHistoryPage> {
    if (!this.enabled) return { messages: [], hasMore: false }
    const channelId = await this.resolveChannelId(args.channel)
    if (channelId === null) return { messages: [], hasMore: false }
    try {
      const raw = (await this.client.query(
        fn<'query'>(this.refs.messages.queries.readChannelHistory),
        this.orgScopedArgs({ channelId, limit: args.limit, before: args.before }),
      )) as {
        messages: Array<{ fromSessionId: string; senderSessionName?: string; text: string; ts: number }>
        hasMore: boolean
      }
      return RemoteTransport.toHistoryPage(raw)
    } catch (err) {
      this.registerFailure('readChannelMessages', err)
      return { messages: [], hasMore: false }
    }
  }

  async readTopicMessages(args: { topicId: string; limit?: number; before?: number }): Promise<TransportHistoryPage> {
    if (!this.enabled) return { messages: [], hasMore: false }
    try {
      const raw = (await this.client.query(
        fn<'query'>(this.refs.messages.queries.readTopicHistory),
        this.orgScopedArgs({ topicId: args.topicId, limit: args.limit, before: args.before }),
      )) as {
        messages: Array<{ fromSessionId: string; senderSessionName?: string; text: string; ts: number }>
        hasMore: boolean
      }
      return RemoteTransport.toHistoryPage(raw)
    } catch (err) {
      this.registerFailure('readTopicMessages', err)
      return { messages: [], hasMore: false }
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────
  async deregisterSession(args: { sessionName: string }): Promise<void> {
    void args.sessionName
    if (!this.enabled || this.sessionId === null) return
    try {
      await this.client.mutation(fn<'mutation'>(this.refs.sessions.mutations.remove), {
        sessionId: this.sessionId,
      })
    } catch {
      // best-effort on shutdown; nothing to do
    }
  }

  // ─── Inbound subscriptions ────────────────────────────────────────────

  /**
   * Subscribe to a topic's reactive message feed. Each new message is passed to
   * `onEvent` as a `ParsedMessage` tagged for the remote source by MessageBus
   * when it pushes.
   *
   * Idempotent, and the feed's LIFECYCLE is the transport's own: suspend on
   * rebind, restore on re-join, forget on a deliberate leave. Callers get no
   * handle back — they name the feed (`forgetTopicFeed`) rather than hold it.
   */
  subscribeTopicMessages(args: { topicId: string; channelName: string }, onEvent: (msg: ParsedMessage) => void): void {
    if (!this.enabled || this.shutdownStarted) return

    // Idempotent by topic id: re-subscribing an already-registered feed keeps
    // the existing one rather than stacking a second onUpdate against the same
    // topic. Callers (auto-subscribe at attach, join_topic, a re-introduce)
    // can all call this freely without coordinating.
    const existing = this.topicFeeds.get(args.topicId)
    if (existing !== undefined) return

    const feed: TopicFeed = { channelName: channelKey(args.channelName), onEvent, inner: null, attached: false }
    this.topicFeeds.set(args.topicId, feed)
    this.attachTopicFeed(args.topicId, feed)
  }

  /**
   * Attach the live Convex `onUpdate` for a topic feed, binding the CURRENT
   * sessionId and cursor into its query args. Called on first subscribe and
   * again on every restore — which is exactly why a rebind cannot leave a feed
   * pointing at a dead session row.
   */
  private attachTopicFeed(topicId: string, feed: TopicFeed): void {
    // Narrow the reactive window server-side with the EXCLUSIVE `sinceTs`
    // cursor: the backend returns messages strictly after it. `topicMaxTs`
    // is primed (via primeTopicCursor) to the last history ts already shown
    // to the user on join, so that boundary message is not replayed. It
    // survives suspend/restore, so a restore replays nothing and loses nothing.
    // The `_id` dedup below still guards against the same row appearing in
    // successive onUpdate batches within one subscription.
    const args = { topicId, channelName: feed.channelName }
    const onEvent = feed.onEvent
    const startingTs = this.topicMaxTs.get(args.topicId)
    const baseArgs: Record<string, unknown> =
      startingTs === undefined ? { topicId: args.topicId } : { topicId: args.topicId, sinceTs: startingTs }
    const queryArgs = this.orgScopedArgs(baseArgs)
    const seen = new BoundedIdSet(DEDUP_CAPACITY)
    const rawUnsubscribe = this.client.onUpdate(
      fn<'query'>(this.refs.messages.queries.listByTopic),
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
          //
          // Read `this.sessionId` LIVE, never a copy captured at subscribe
          // time: auto-subscribed topics are subscribed before the agent
          // introduces itself, and `introduce` rebinds the session row. A
          // captured id would go stale on that rename and we'd start
          // pushing our own messages back at ourselves.
          if (row.fromSessionId === this.sessionId) continue
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
    // The topic onUpdate registers synchronously, so the feed is live here.
    feed.inner = rawUnsubscribe
    feed.attached = true
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
  subscribeChannelMessages(args: { channelName: string }, onEvent: (msg: ParsedMessage) => void): void {
    if (!this.enabled || this.shutdownStarted) return

    // Idempotent by NORMALIZED channel name — see `channelKey`.
    const key = channelKey(args.channelName)
    const existing = this.channelFeeds.get(key)
    if (existing !== undefined) return

    const feed: ChannelFeed = { onEvent, inner: null, attached: false }
    this.channelFeeds.set(key, feed)
    this.attachChannelFeed(key, feed)
  }

  /**
   * Attach the live Convex `onUpdate` for a channel feed under the CURRENT
   * sessionId and cursor. Symmetric to `registerTopicFeed`; re-run on restore.
   */
  private attachChannelFeed(channelName: string, feed: ChannelFeed): void {
    const args = { channelName }
    const onEvent = feed.onEvent
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
      // Narrow the initial reactive batch past the channel's join-time
      // history. `channelMaxTs` is seeded by `joinChannel` (and advanced by
      // this callback). An explicit `sinceTs` overrides the server-side
      // read cursor, so a first-ever join — which has no cursor yet — does
      // not replay the channel's whole broadcast history.
      const startingTs = this.channelMaxTs.get(channelId)
      if (startingTs !== undefined) queryArgs.sinceTs = startingTs
      innerUnsubscribe = this.client.onUpdate(
        fn<'query'>(this.refs.messages.queries.listByChannel),
        queryArgs,
        (rows) => {
          const arr = rows as Array<{ _id: string; fromSessionId: string; text: string; ts: number }>
          let highestTsInBatch = 0
          // Read the session id LIVE per batch rather than reusing the
          // subscribe-time `sessionId` above: `introduce` rebinds the
          // session row, and channels are auto-subscribed before the agent
          // introduces itself, so the captured id goes stale on that rename
          // and we'd echo our own broadcasts back at ourselves. (The read
          // cursor / ack keep using the subscribe-time id - they belong to
          // the row the query was registered against.)
          const ownSessionId = this.sessionId
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
            if (ownSessionId !== null && row.fromSessionId === ownSessionId) continue
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
              .mutation(fn<'mutation'>(this.refs.messages.mutations.ackChannel), {
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
      // ONLY here is the feed genuinely live. The id lookup below may be async
      // and may never get here (throw / no match), and the caller already holds
      // a non-null `inner` by then — which is exactly why `attached`, not
      // `inner`, is what liveness is read from.
      feed.attached = true
    }

    const cached = this.channelIdsByName.get(args.channelName)
    if (cached !== undefined) {
      register(cached)
    } else {
      void (async () => {
        try {
          const rows = (await this.client.query(
            fn<'query'>(this.refs.channels.queries.listAll),
            this.orgScopedArgs({}),
          )) as Array<{
            channelId: string
            name: string
          }>
          const match = rows.find((r) => channelKey(r.name) === args.channelName)
          if (match !== undefined) {
            this.channelIdsByName.set(args.channelName, match.channelId)
            register(match.channelId)
          }
        } catch (err) {
          this.registerFailure('subscribeChannelMessages.lookup', err)
        }
      })()
    }

    feed.inner = (): void => {
      unsubscribed = true
      if (innerUnsubscribe !== null) {
        try {
          innerUnsubscribe()
        } catch {
          /* best-effort */
        }
        innerUnsubscribe = null
      }
    }
  }

  // ─── Feed lifecycle ───────────────────────────────────────────────────

  /** Detach a feed's live subscription, leaving the registry entry intact. */
  private detach(feed: FeedState): void {
    feed.attached = false
    if (feed.inner === null) return
    const inner = feed.inner
    feed.inner = null
    try {
      inner()
    } catch (err) {
      this.log(`feed detach failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Suspend the feed for one topic. Safe when absent or already suspended. */
  private suspendTopicFeed(topicId: string): void {
    const feed = this.topicFeeds.get(topicId)
    if (feed !== undefined) this.detach(feed)
  }

  /**
   * Suspend a channel's feed AND every topic feed inside it. The backend's
   * `listByTopic` asserts CHANNEL presence, so a topic feed left live across
   * the loss of channel membership starts throwing ConvexError — and three of
   * those disable the whole transport.
   */
  private suspendChannelFeed(name: string): void {
    const key = channelKey(name)
    const channel = this.channelFeeds.get(key)
    if (channel !== undefined) this.detach(channel)
    for (const feed of this.topicFeeds.values()) {
      if (feed.channelName === key) this.detach(feed)
    }
  }

  /** Re-attach a suspended topic feed under the current sessionId + cursor. */
  private restoreTopicFeed(topicId: string): void {
    if (!this.enabled || this.shutdownStarted) return
    const feed = this.topicFeeds.get(topicId)
    if (feed === undefined || feed.attached) return
    this.attachTopicFeed(topicId, feed)
  }

  /** Re-attach a suspended channel feed under the current sessionId + cursor.
   *  Deliberately does NOT restore the channel's topic feeds: their topic
   *  membership may not be back yet. `joinTopic` restores those. */
  private restoreChannelFeed(name: string): void {
    if (!this.enabled || this.shutdownStarted) return
    const key = channelKey(name)
    const feed = this.channelFeeds.get(key)
    if (feed === undefined || feed.attached) return
    this.attachChannelFeed(key, feed)
  }

  /**
   * Drop a topic feed for good: the topic is gone for us, so it must not linger
   * as "suspended" and make the location look deaf, nor be resurrected by a
   * later join.
   *
   * This encodes user INTENT, which the transport cannot infer — `leaveTopic` is
   * issued both by a deliberate `leave_topic` and by the identity migration's
   * transient leave, and only the former means "forget this".
   *
   * NOT called on archive_topic. Archiving deliberately KEEPS the feed so the
   * session still hears its own topic being unarchived (KAI-373).
   */
  forgetTopicFeed(topicId: string): void {
    const feed = this.topicFeeds.get(topicId)
    if (feed === undefined) return
    this.topicFeeds.delete(topicId)
    this.detach(feed)
  }

  /**
   * Drop a channel's feed AND the feeds of every topic inside it, AND its
   * delivery cursor. Deliberate `leave_channel` only — see `forgetTopicFeed`.
   *
   * The cursor is part of the same intent, not a separate errand. `joinChannel`
   * seeds a cursor only when absent — which is what stops the identity
   * migration's transient leave/re-join from skipping broadcasts that land
   * mid-rename — but it also means a cursor left behind by an INTENTIONAL leave
   * would survive, and a later re-join would replay the whole backlog as fresh
   * notifications. Forgetting both together keeps the two leaves distinct:
   * transient (migration) keeps its place in the stream, deliberate (tool)
   * starts fresh. They were two calls the tool had to remember to keep in sync;
   * either one forgotten reintroduces a bug, so they are now one.
   */
  forgetChannelFeed(name: string): void {
    const key = channelKey(name)
    const channelId = this.channelIdsByName.get(key)
    if (channelId !== undefined) this.channelMaxTs.delete(channelId)
    const channel = this.channelFeeds.get(key)
    if (channel !== undefined) {
      this.channelFeeds.delete(key)
      this.detach(channel)
    }
    for (const [topicId, feed] of [...this.topicFeeds]) {
      if (feed.channelName !== key) continue
      this.topicFeeds.delete(topicId)
      this.detach(feed)
    }
  }

  /**
   * The feeds this transport holds but cannot currently deliver on — i.e.
   * exactly where the session is deaf. A feed is suspended when the identity or
   * membership behind it went away and the join that would restore it has not
   * happened (or failed). The tool layer reports these as `degraded` instead of
   * peeking at bookkeeping it no longer owns.
   */
  hasLiveTopicFeed(topicId: string): boolean {
    return this.topicFeeds.get(topicId)?.attached === true
  }

  hasLiveChannelFeed(name: string): boolean {
    return this.channelFeeds.get(channelKey(name))?.attached === true
  }

  suspendedFeeds(): { topics: string[]; channels: string[] } {
    const topics: string[] = []
    const channels: string[] = []
    for (const [topicId, feed] of this.topicFeeds) {
      if (!feed.attached) topics.push(topicId)
    }
    for (const [name, feed] of this.channelFeeds) {
      if (!feed.attached) channels.push(name)
    }
    return { topics, channels }
  }

  /**
   * Seed the per-channel `sinceTs` cursor (by channel id) so the next
   * `subscribeChannelMessages` call skips broadcasts older than `ts`.
   * No-op if the channel name hasn't been resolved yet.
   */
  primeChannelCursor(channelName: string, ts: number): void {
    const channelId = this.channelIdsByName.get(channelKey(channelName))
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
    // Detach every live feed and drop the registries, so nothing can be
    // restored after shutdown and no inner callback is in flight when the
    // websocket goes.
    for (const feed of this.topicFeeds.values()) this.detach(feed)
    for (const feed of this.channelFeeds.values()) this.detach(feed)
    this.topicFeeds.clear()
    this.channelFeeds.clear()
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
   * returned fn out - e.g. to `server.ts`'s `remoteTopicUnsubscribes` /
   * `remoteChannelUnsubscribes` maps - and `shutdown()` still catches it
   * via the internal set.
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
