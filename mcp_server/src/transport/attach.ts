import type { ActiveContext } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import type { ResolvedLocation } from '../config/resolve.js'
import type { ParsedMessage } from '../types.js'
import { createRemoteClient } from '../remote/client.js'
import { RemoteTransport } from './remote.js'
import type { TransportRouter } from './router.js'
import type { Transport, TransportTopicMessage } from './index.js'

/**
 * Everything `attachLocation` needs to turn a resolved non-local
 * location into a running transport and wire it into the session.
 *
 * This context is intentionally a superset of what `server.ts` holds
 * at startup so both the cold-start loop and the hot-attach path (the
 * `authenticate` tool, after `runAuthenticate` returns) can call the
 * same function and produce the same runtime shape.
 *
 * `transportFactory` is injectable so tests can swap in a FakeTransport
 * and drive the auto-subscribe / DM-wiring / replace-in-place branches
 * without standing up a real Convex client.
 */
export interface AttachCtx {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  messageBus: MessageBus
  /** Mutable map of DM-subscription unsubscribe callbacks, keyed by
   *  location name. `server.ts`'s shutdown hook drains the whole map on
   *  SIGTERM / stdin close; `attachLocation`'s replace-in-place path
   *  looks up the old entry by location name and invokes it before
   *  swapping the new transport in. One subscription per location. */
  remoteUnsubscribes: Map<string, () => void>
  /** Mutable map of topic-message subscription unsubscribe callbacks,
   *  keyed by `${location}::${topicId}`. Populated when a remote
   *  transport establishes a `subscribeTopicMessages` reactive feed
   *  during the auto-subscribe loop, and mirrored in the tool layer's
   *  join/start paths so a user-triggered `join_topic` or `start_topic`
   *  also wires an inbound stream. Drained on shutdown and on the
   *  replace-in-place path in the same way as `remoteUnsubscribes`. */
  remoteTopicUnsubscribes: Map<string, () => void>
  /** Mutable map of channel-message subscription unsubscribe callbacks,
   *  keyed by `${location}::${channelName}`. Populated on channel join
   *  (auto-subscribe at attach time, or runtime via `join_channel`);
   *  drained on `leave_channel`, shutdown, and replace-in-place. Mirrors
   *  the shape of `remoteTopicUnsubscribes`. */
  remoteChannelUnsubscribes: Map<string, () => void>
  /** Snapshot view of the resolved config at the time the context was
   *  built. `server.ts` passes this from its `resolveConfig` result;
   *  the hot-attach path re-resolves before calling. */
  resolved: AttachResolved
  /** How to turn a ResolvedLocation into a live Transport. The default
   *  (`defaultTransportFactory`) builds a `RemoteTransport` wrapping a
   *  `ConvexClient`; tests pass a fake. */
  transportFactory?: (location: ResolvedLocation) => Transport
}

/** Subset of `ResolvedConfig` that `attachLocation` needs. Kept
 *  separate so tests don't have to populate the full config tree. */
export interface AttachResolved {
  locations: ResolvedLocation[]
  activeLocation?: string
  activeChannel?: { location: string; name: string }
  activeTopic?: { location: string; channel: string; name: string }
}

/** Result of one attach attempt. On success the caller holds the new
 *  transport and can surface an "is now active" message; on failure the
 *  tokens remain on disk and the caller falls back to "restart to
 *  activate." */
export type AttachResult =
  | { ok: true; transport: Transport; location: ResolvedLocation }
  | { ok: false; reason: string }

/**
 * Turn one resolved non-local location into a running transport and
 * wire it into the session. Shared by the startup loop in `server.ts`
 * and by the `authenticate` tool's hot-attach path.
 *
 * Order of operations (deliberately this one):
 *
 *   1. Look up the location in `ctx.resolved.locations`.
 *   2. Build (or factory) the transport.
 *   3. Call `introduce()` FIRST. If it throws, abort before touching
 *      the router - the "never leave a broken transport in the router"
 *      invariant is what lets a hot-attach failure degrade to the old
 *      "restart to activate" message without corrupting runtime state.
 *   4. If a prior transport exists for the same name, tear it down
 *      (`deregisterSession` + stored unsubscribe) before swapping.
 *   5. Register the new transport with the router.
 *   6. Wire the DM inbox reactive subscription via MessageBus and push
 *      the unsubscribe fn onto `remoteUnsubscribes` so shutdown cleans
 *      it up.
 *   7. Best-effort auto-subscribe: join configured channels, join-or-
 *      create configured topics. Failures here are logged and swallowed
 *      - the transport is live at this point so the attach has already
 *      succeeded.
 *   8. If no channel is currently runtime-active, optionally cascade
 *      the resolved-config's active state into `ActiveContext`. This
 *      matches the startup cold-path behaviour while protecting a user
 *      who may have `set_active_channel`'d elsewhere after startup.
 */
export async function attachLocation(name: string, ctx: AttachCtx): Promise<AttachResult> {
  const location = ctx.resolved.locations.find((l) => l.name === name)
  if (!location) {
    return { ok: false, reason: `Location "${name}" is not present in the resolved config.` }
  }
  if (location.isLocal) {
    return {
      ok: false,
      reason: `Location "${name}" is the reserved local broker location; attachLocation is for remote transports only.`,
    }
  }
  if (!location.url) {
    return { ok: false, reason: `Location "${name}" has no URL configured.` }
  }
  if (!location.accessToken || !location.refreshToken) {
    return { ok: false, reason: `Location "${name}" has no tokens; call authenticate first.` }
  }

  const factory = ctx.transportFactory ?? defaultTransportFactory
  let transport: Transport
  try {
    transport = factory(location)
  } catch (err) {
    return { ok: false, reason: `Could not construct transport: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Step 3: introduce FIRST. A failure here must not register the
  // transport with the router - otherwise subsequent tool calls would
  // hit a half-wired transport and the caller has no way to roll back.
  if (!ctx.session.hasName()) {
    // If the session never introduced in this process, skip the
    // introduce call but still register. The identity tool's own
    // introduce path re-registers across every enabled transport when
    // the user eventually calls it.
  } else {
    const displayName = ctx.session.displayName
    const objective = ctx.session.getObjective()
    try {
      await transport.introduce({ sessionName: displayName, objective })
    } catch (err) {
      return {
        ok: false,
        reason: `introduce() failed for "${name}": ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Step 4 + 5: if something else holds this name in the router, tear
  // it down first. Order matters:
  //   (a) invoke the prior transport's stored DM unsubscribe - this
  //       closes out the reactive subscription and releases the
  //       MessageBus callback reference.
  //   (b) call its `deregisterSession` so the backend stops attributing
  //       messages to a stale session id.
  //   (c) call its `shutdown()` so the underlying ConvexClient websocket
  //       is closed and any in-flight callbacks stop firing.
  //
  // Each step is best-effort; an error in one must not block the next
  // because the overall goal is "no live references to the prior
  // transport survive this function."
  const prior = ctx.router.unregister(name)
  if (prior) {
    const priorUnsub = ctx.remoteUnsubscribes.get(name)
    if (priorUnsub !== undefined) {
      ctx.remoteUnsubscribes.delete(name)
      try {
        priorUnsub()
      } catch (err) {
        logError(
          `Prior transport DM unsubscribe failed for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    // Tear down every topic subscription owned by the prior transport
    // before the swap. Keys are `${location}::${topicId}`; we filter by
    // the location prefix so other locations' subscriptions are
    // preserved. Each unsubscribe is best-effort; an error in one must
    // not block the rest.
    const prefix = `${name}::`
    for (const [key, unsub] of [...ctx.remoteTopicUnsubscribes.entries()]) {
      if (!key.startsWith(prefix)) continue
      ctx.remoteTopicUnsubscribes.delete(key)
      try {
        unsub()
      } catch (err) {
        logError(
          `Prior transport topic unsubscribe failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    for (const [key, unsub] of [...ctx.remoteChannelUnsubscribes.entries()]) {
      if (!key.startsWith(prefix)) continue
      ctx.remoteChannelUnsubscribes.delete(key)
      try {
        unsub()
      } catch (err) {
        logError(
          `Prior transport channel unsubscribe failed for "${key}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (ctx.session.hasName()) {
      try {
        await prior.deregisterSession({ sessionName: ctx.session.displayName })
      } catch {
        // best-effort teardown; continue
      }
    }
    if (typeof prior.shutdown === 'function') {
      try {
        await prior.shutdown()
      } catch (err) {
        logError(`Prior transport shutdown failed for "${name}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  ctx.router.register(transport)

  // Step 6: DM subscription, if this transport supports one. The map is
  // keyed by location name so a subsequent re-attach can find and tear
  // down this subscription cleanly.
  if (hasDirectMessageSubscription(transport)) {
    try {
      const unsub = transport.subscribeDirectMessages((msg) => {
        void ctx.messageBus.push(msg, transport.source)
      })
      ctx.remoteUnsubscribes.set(name, unsub)
    } catch (err) {
      // A transport that advertises the subscription method but throws
      // on the first call is unusual; log and continue so the rest of
      // the transport still works.
      logError(`DM subscription wiring failed for "${name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Step 7: auto-subscribe to configured channels and topics.
  const displayName = ctx.session.hasName() ? ctx.session.displayName : undefined
  if (displayName !== undefined) {
    for (const channel of location.channels) {
      try {
        await transport.joinChannel({ sessionName: displayName, channel: channel.name })
      } catch (err) {
        logError(
          `Auto-join channel "${channel.name}" at "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      ensureChannelSubscription({
        transport,
        locationName: name,
        channelName: channel.name,
        messageBus: ctx.messageBus,
        map: ctx.remoteChannelUnsubscribes,
      })
      try {
        ctx.context.joinChannel(channel.name, 'cccollab.json', name)
      } catch (err) {
        logError(
          `Auto-subscribe bookkeeping for channel "${channel.name}" at "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }

      if (channel.topics.length === 0) continue

      let existing: Array<{ id: string; topic: string }> = []
      try {
        const rows = await transport.listTopics({
          sessionName: displayName,
          channel: channel.name,
          includeArchived: false,
        })
        existing = rows.map((r) => ({ id: r.id, topic: r.topic }))
      } catch {
        /* transport unreachable / unsupported; fall back to create */
      }

      for (const topic of channel.topics) {
        const found = existing.find((t) => t.topic.toLowerCase() === topic.name.toLowerCase())
        try {
          let topicId: string
          let historyHighestTs: number | undefined
          if (found) {
            const joined = await transport.joinTopic({ sessionName: displayName, topicId: found.id })
            ctx.context.joinTopic(found.id, topic.name, channel.name, name)
            topicId = found.id
            historyHighestTs = highestHistoryTs(joined.history)
          } else {
            const created = await transport.createTopic({
              sessionName: displayName,
              channel: channel.name,
              topic: topic.name,
            })
            ctx.context.joinTopic(created.id, topic.name, channel.name, name)
            topicId = created.id
            // Fresh topic: no history, so prime to "now" to avoid a
            // replay if another producer happens to post while the
            // initial subscribe round-trips.
            historyHighestTs = Date.now()
          }
          ensureTopicSubscription({
            transport,
            locationName: name,
            topicId,
            channelName: channel.name,
            sinceTs: historyHighestTs,
            messageBus: ctx.messageBus,
            map: ctx.remoteTopicUnsubscribes,
          })
        } catch (err) {
          logError(
            `Auto-subscribe topic "${topic.name}" at "${name}"/"${channel.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
  }

  // Step 8: cascade active state iff no channel is currently active.
  // We read the live ActiveContext, not the resolved config, so a user
  // who has since `set_active_channel`'d somewhere else keeps their
  // focus.
  const currentActive = ctx.context.getActiveChannelRef()
  if (currentActive === undefined && ctx.resolved.activeChannel) {
    const ac = ctx.resolved.activeChannel
    if (ac.location === name && ctx.context.isChannelSubscribed(ac.name, name)) {
      try {
        ctx.context.setActiveChannel(ac.name, name)
      } catch {
        /* shouldn't happen given the isChannelSubscribed guard */
      }
    }
  }

  return { ok: true, transport, location }
}

/**
 * Default production factory. Tests override via `ctx.transportFactory`.
 * Kept as a named export so `server.ts` can call it from its startup
 * loop without instantiating the context machinery just to get a
 * transport.
 */
export function defaultTransportFactory(location: ResolvedLocation): Transport {
  if (location.isLocal || !location.url) {
    throw new Error(`defaultTransportFactory called with local or URL-less location: "${location.name}"`)
  }
  if (!location.clerkIssuer || !location.clerkClientId) {
    throw new Error(
      `defaultTransportFactory: location "${location.name}" is missing clerkIssuer or clerkClientId — every non-local location must supply the Clerk app pointer.`,
    )
  }
  const client = createRemoteClient({
    locationName: location.name,
    url: location.url,
    accessToken: location.accessToken ?? '',
    refreshToken: location.refreshToken ?? '',
    accessTokenExpiresAt: location.accessTokenExpiresAt,
    clerkIssuer: location.clerkIssuer,
    clerkClientId: location.clerkClientId,
    userEmail: location.userEmail,
    userId: location.userId,
  })
  return new RemoteTransport({ client, source: location.name })
}

/** Type guard: does this transport expose a DM reactive subscription?
 *  Both the real `RemoteTransport` and the test `FakeRemoteTransport`
 *  do; `LocalTransport` does not (broker DMs arrive via the SSE
 *  `BrokerEventListener` instead). */
function hasDirectMessageSubscription(
  transport: Transport,
): transport is Transport & { subscribeDirectMessages: RemoteTransport['subscribeDirectMessages'] } {
  return typeof (transport as { subscribeDirectMessages?: unknown }).subscribeDirectMessages === 'function'
}

/** Type guard: does this transport expose per-topic reactive subscriptions?
 *  Only remote transports do; the local broker pushes topic messages via
 *  its shared SSE stream handled by `BrokerEventListener`. */
export function hasTopicSubscription(transport: Transport): transport is Transport & {
  subscribeTopicMessages: RemoteTransport['subscribeTopicMessages']
  primeTopicCursor: RemoteTransport['primeTopicCursor']
} {
  return (
    typeof (transport as { subscribeTopicMessages?: unknown }).subscribeTopicMessages === 'function' &&
    typeof (transport as { primeTopicCursor?: unknown }).primeTopicCursor === 'function'
  )
}

/** Type guard: does this transport expose per-channel reactive
 *  broadcast subscriptions? Only remote transports do. */
export function hasChannelSubscription(transport: Transport): transport is Transport & {
  subscribeChannelMessages: RemoteTransport['subscribeChannelMessages']
} {
  return typeof (transport as { subscribeChannelMessages?: unknown }).subscribeChannelMessages === 'function'
}

/**
 * Establish a channel-broadcast subscription on a remote transport if one
 * isn't already in place. Idempotent; keyed by
 * `${locationName}::${channelName}`.
 *
 * Channel broadcasts are the fanout path for `send_message_to_channel` at
 * the broker level on local and at the Convex level on remote. Without
 * this wiring a remote broadcast lands in the backend table but never
 * reaches other subscribers - see the original bug report for symptoms.
 */
export function ensureChannelSubscription(args: {
  transport: Transport
  locationName: string
  channelName: string
  messageBus: MessageBus
  map: Map<string, () => void>
}): void {
  const key = `${args.locationName}::${args.channelName}`
  if (args.map.has(key)) return
  if (!hasChannelSubscription(args.transport)) return
  const unsub = args.transport.subscribeChannelMessages({ channelName: args.channelName }, (msg: ParsedMessage) => {
    void args.messageBus.push(msg, args.transport.source)
  })
  args.map.set(key, unsub)
}

/**
 * Tear down one channel subscription. Safe to call when none exists
 * (returns without error). Used by `leave_channel` and the
 * replace-in-place path in `attachLocation`.
 */
export function teardownChannelSubscription(args: {
  locationName: string
  channelName: string
  map: Map<string, () => void>
}): void {
  const key = `${args.locationName}::${args.channelName}`
  const unsub = args.map.get(key)
  if (unsub === undefined) return
  args.map.delete(key)
  try {
    unsub()
  } catch (err) {
    logError(`Channel unsubscribe failed for "${key}": ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Establish a topic-message subscription on a remote transport if one
 * isn't already in place. Idempotent: re-entry with the same
 * `${location}::${topicId}` key is a no-op, so auto-subscribe at startup
 * plus a later user-triggered `join_topic` on the same topic don't
 * double-wire.
 *
 * Local transports don't participate here (their topic messages flow via
 * the broker's shared SSE stream, handled by `BrokerEventListener`);
 * `hasTopicSubscription` type-guards that case so the call degrades to
 * a no-op without a runtime check at every call site.
 *
 * Priming: `sinceTs`, if provided, is passed to `primeTopicCursor` so
 * the initial `onUpdate` batch is narrowed server-side and a freshly
 * joined topic's history (already returned via `joinTopic`) does not
 * get replayed to the user as inbound notifications.
 */
export function ensureTopicSubscription(args: {
  transport: Transport
  locationName: string
  topicId: string
  channelName: string
  sinceTs?: number
  messageBus: MessageBus
  map: Map<string, () => void>
}): void {
  const key = `${args.locationName}::${args.topicId}`
  if (args.map.has(key)) return
  if (!hasTopicSubscription(args.transport)) return
  if (args.sinceTs !== undefined) {
    args.transport.primeTopicCursor(args.topicId, args.sinceTs)
  }
  const unsub = args.transport.subscribeTopicMessages(
    { topicId: args.topicId, channelName: args.channelName },
    (msg: ParsedMessage) => {
      void args.messageBus.push(msg, args.transport.source)
    },
  )
  args.map.set(key, unsub)
}

/**
 * Tear down one topic subscription. Safe to call when none exists
 * (returns without error). Used by `leave_topic`, `archive_topic`, and
 * the replace-in-place path in `attachLocation` when the prior
 * transport's per-location subscriptions need to be drained before the
 * swap.
 */
export function teardownTopicSubscription(args: {
  locationName: string
  topicId: string
  map: Map<string, () => void>
}): void {
  const key = `${args.locationName}::${args.topicId}`
  const unsub = args.map.get(key)
  if (unsub === undefined) return
  args.map.delete(key)
  try {
    unsub()
  } catch (err) {
    logError(`Topic unsubscribe failed for "${key}": ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Highest history message ts as epoch ms, or undefined when the array
 *  is empty. `TransportTopicMessage.ts` is an ISO string; unparseable
 *  entries are skipped. */
function highestHistoryTs(history: TransportTopicMessage[]): number | undefined {
  let max: number | undefined
  for (const row of history) {
    const parsed = Date.parse(row.ts)
    if (Number.isNaN(parsed)) continue
    if (max === undefined || parsed > max) max = parsed
  }
  return max
}

function logError(message: string): void {
  process.stderr.write(`[cccollab] ${message}\n`)
}
