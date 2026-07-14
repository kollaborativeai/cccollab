import type { ActiveContext } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import type { ResolvedLocation } from '../config/resolve.js'
import type { ParsedMessage } from '../types.js'
import { createRemoteClient } from '../remote/client.js'
import { assertSecureBearerUrl } from '../remote/auth-clerk.js'
import { RemoteTransport } from './remote.js'
import type { TransportRouter } from './router.js'
import type { AttachDiagnostics } from './diagnostics.js'
import { LOCAL_LOCATION, type Transport, type TransportTopicMessage } from './index.js'

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
 * and drive the auto-subscribe / replace-in-place branches
 * without standing up a real Convex client.
 */
export interface AttachCtx {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  messageBus: MessageBus
  /** Mutable map of topic-message subscription unsubscribe callbacks,
   *  keyed by `${location}::${topicId}`. Populated when a remote
   *  transport establishes a `subscribeTopicMessages` reactive feed
   *  during the auto-subscribe loop, and mirrored in the tool layer's
   *  join/start paths so a user-triggered `join_topic` or `start_topic`
   *  also wires an inbound stream. Drained on shutdown and on the
   *  replace-in-place path (filtered by the location-name prefix). */
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
  /** Optional registry of failed attaches (KAI-368). When present,
   *  `attachLocation` records the reason on every failure return and
   *  clears it on success, so `whoami`/`list_locations` can surface a
   *  location that failed to attach even though it is deliberately never
   *  placed in the router. */
  diagnostics?: AttachDiagnostics
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
 *   6. Best-effort auto-subscribe: join configured channels, join-or-
 *      create configured topics. Failures here are logged and swallowed
 *      - the transport is live at this point so the attach has already
 *      succeeded.
 *   7. If no channel is currently runtime-active, optionally cascade
 *      the resolved-config's active state into `ActiveContext`. This
 *      matches the startup cold-path behaviour while protecting a user
 *      who may have `set_active_channel`'d elsewhere after startup.
 */
export async function attachLocation(name: string, ctx: AttachCtx): Promise<AttachResult> {
  // Record every failure in the diagnostics registry (when one is wired
  // in) so a location that never makes it into the router is still
  // visible via whoami/list_locations. The success path clears it.
  const fail = (reason: string): AttachResult => {
    ctx.diagnostics?.recordFailure(name, reason)
    return { ok: false, reason }
  }

  const location = ctx.resolved.locations.find((l) => l.name === name)
  if (!location) {
    return fail(`Location "${name}" is not present in the resolved config.`)
  }
  if (location.isLocal) {
    return fail(
      `Location "${name}" is the reserved local broker location; attachLocation is for remote transports only.`,
    )
  }
  if (!location.url) {
    return fail(`Location "${name}" has no URL configured.`)
  }
  if (!location.accessToken || !location.refreshToken) {
    return fail(`Location "${name}" has no tokens; call authenticate first.`)
  }

  const factory = ctx.transportFactory ?? defaultTransportFactory
  let transport: Transport
  try {
    transport = factory(location)
  } catch (err) {
    return fail(`Could not construct transport: ${err instanceof Error ? err.message : String(err)}`)
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
      // The transport was constructed (its ConvexClient opened a
      // websocket and installed an auth fetcher) but never registered.
      // Tear it down before bailing so no orphaned client keeps running
      // with no owner — an unowned background rejection (e.g. a prod
      // "Server Error") would otherwise crash the whole process, killing
      // this session's in-process local transport (and, because every
      // session loads the same config, each of them in turn) (KAI-368).
      // Best-effort: shutdown() never throws, but guard anyway so a
      // cleanup hiccup can't mask the original introduce failure.
      if (typeof transport.shutdown === 'function') {
        try {
          await transport.shutdown()
        } catch (shutdownErr) {
          logError(
            `Cleanup of failed attach for "${name}" hit an error: ${shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr)}`,
          )
        }
      }
      return fail(`introduce() failed for "${name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Step 4 + 5: if something else holds this name in the router, tear
  // it down first. Order matters:
  //   (a) tear down its topic and channel subscriptions so the reactive
  //       feeds close and release their MessageBus callback references.
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

  // Step 6: auto-subscribe to configured channels and topics.
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

  // Attach succeeded — clear any earlier recorded failure so a location
  // that has recovered stops being surfaced as degraded.
  ctx.diagnostics?.clear(name)
  return { ok: true, transport, location }
}

/**
 * Everything `ensureLazyAttach` needs to bring a dormant-but-token-bearing
 * location online the first time a tool touches it. It is the superset of
 * `AttachCtx`'s static collaborators plus the bookkeeping that makes lazy
 * attach safe to call on the hot path of every tool invocation.
 */
export interface LazyAttachCtx {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  messageBus: MessageBus
  remoteTopicUnsubscribes: Map<string, () => void>
  remoteChannelUnsubscribes: Map<string, () => void>
  /** In-flight (and completed) lazy-attach attempts, keyed by location name.
   *  The first caller for a name stores its attach promise here; concurrent
   *  and later callers await that same promise instead of starting a second
   *  attach — this both dedupes overlapping tool calls (no double introduce /
   *  websocket) and keeps a stale/unreachable remote from being retried on
   *  every tool call. A failed attempt's resolved promise is retained so the
   *  dead remote is tried at most once per process; a non-constructable
   *  location's entry is dropped so a later token write can still be picked
   *  up (see `lazyAttachOne`). */
  inflight: Map<string, Promise<void>>
  /** Non-local location names eligible for lazy attach (the non-local
   *  locations present in the startup config). Used as the candidate set
   *  when `target` is undefined ("every non-local"). */
  candidates: string[]
  /** Re-resolve the config so a location authenticated (or refreshed by a
   *  peer process) since startup is attached with its current tokens. Only
   *  invoked when there is an unregistered, not-yet-in-flight candidate, so
   *  the common already-attached path costs nothing. */
  resolve: () => AttachResolved
  /** Passed through to `attachLocation`; tests inject a fake. */
  transportFactory?: (location: ResolvedLocation) => Transport
  /** Passed through to `attachLocation` so a failed lazy attach is
   *  recorded (and a recovered one cleared) in the shared diagnostics
   *  registry — see `AttachCtx.diagnostics`. */
  diagnostics?: AttachDiagnostics
}

/** Can this location be turned into a live transport? Mirrors the
 *  constructability half of `planStartupAttachments` (url + tokens + Clerk
 *  pointer, matching `defaultTransportFactory`). A location that fails this
 *  is not attemptable yet — it is not recorded as a spent attempt, so a
 *  later config re-resolve (peer token write) can still pick it up. */
function isConstructable(location: ResolvedLocation | undefined): location is ResolvedLocation {
  return (
    !!location &&
    !location.isLocal &&
    !!location.url &&
    !!location.accessToken &&
    !!location.refreshToken &&
    !!location.clerkIssuer &&
    !!location.clerkClientId
  )
}

const NOOP_ATTACH: Promise<void> = Promise.resolve()

/** Attach one location, deduping against any in-flight/completed attempt.
 *  Synchronously records its promise in `ctx.inflight` *before* the first
 *  await so a concurrent caller observes it and awaits rather than starting
 *  a second attach. */
function lazyAttachOne(name: string, ctx: LazyAttachCtx, resolved: AttachResolved, force: boolean): Promise<void> {
  if (name === LOCAL_LOCATION || ctx.router.has(name)) return NOOP_ATTACH
  if (!force) {
    const existing = ctx.inflight.get(name)
    if (existing) return existing
  }
  // Constructability is checked synchronously, before registering the
  // in-flight promise: a not-yet-attemptable location (missing url/tokens/
  // Clerk) must NOT be memoized, so a later resolve picking up peer-written
  // tokens can still attach it.
  const location = resolved.locations.find((l) => l.name === name)
  if (!isConstructable(location)) return NOOP_ATTACH
  const attempt = (async () => {
    const result = await attachLocation(name, {
      session: ctx.session,
      context: ctx.context,
      router: ctx.router,
      messageBus: ctx.messageBus,
      remoteTopicUnsubscribes: ctx.remoteTopicUnsubscribes,
      remoteChannelUnsubscribes: ctx.remoteChannelUnsubscribes,
      resolved,
      transportFactory: ctx.transportFactory,
      diagnostics: ctx.diagnostics,
    })
    if (!result.ok) {
      // Retain the resolved in-flight entry so the dead remote is not retried
      // on every subsequent tool call this session.
      logError(`Lazy-attach for "${name}" failed: ${result.reason}`)
    }
  })()
  ctx.inflight.set(name, attempt)
  return attempt
}

/**
 * Attach a token-bearing non-local location on demand so a valid remote in
 * config "just works" through any tool without an explicit `authenticate`
 * call. Startup gating (`planStartupAttachments`) deliberately leaves a
 * dormant remote unattached to avoid touching stale endpoints on every
 * launch; this restores access the moment a tool actually needs the
 * location.
 *
 *   - `target` names a single location; `undefined` means "every non-local
 *     candidate" (the list/broadcast tools that union across transports).
 *   - Implicit (tool-triggered) attach only fires once the session has a
 *     name. Before `introduce`, attachLocation would register a remote
 *     *without* a validating introduce, which then trips the org-required
 *     gate on the eventual introduce. `authenticate` opts in explicitly via
 *     `opts.force`, which also bypasses the once-per-session guard so an
 *     earlier transient failure can't block a deliberate sign-in.
 *   - `opts.allowWithoutName` lifts only the name gate (keeping the inflight
 *     dedup and once-per-session guard) for tools that are *meant* to run
 *     before `introduce` — `list_organizations`, the org-discovery tool you
 *     call to pick an org to introduce with. Without it that tool is a
 *     chicken-and-egg dead end on a session that has not yet introduced.
 *   - Concurrent calls for the same location dedupe through `ctx.inflight`,
 *     so a name is attached at most once even under overlapping tool calls.
 *   - A location missing url / tokens / Clerk pointer is skipped quietly and
 *     not recorded as spent (a later token write is still picked up).
 *   - Best-effort: a failed attach is logged and swallowed; the caller
 *     proceeds and the router surfaces "not configured / degraded".
 */
export async function ensureLazyAttach(
  target: string | undefined,
  ctx: LazyAttachCtx,
  opts: { force?: boolean; allowWithoutName?: boolean } = {},
): Promise<void> {
  const force = opts.force === true
  if (!force && !opts.allowWithoutName && !ctx.session.hasName()) return

  const names = (target !== undefined ? [target] : ctx.candidates).filter((n) => n !== LOCAL_LOCATION)
  // Resolve config only when at least one requested name needs a fresh
  // attempt; otherwise every name is already attached or in flight.
  const needsWork = names.some((n) => !ctx.router.has(n) && (force || !ctx.inflight.has(n)))
  if (!needsWork) {
    // Still await any in-flight attempts for the requested names so a caller
    // doesn't proceed to router.get() before a concurrent attach completes.
    await Promise.all(names.map((n) => ctx.inflight.get(n)).filter((p): p is Promise<void> => p !== undefined))
    return
  }
  const resolved = ctx.resolve()
  await Promise.all(names.map((n) => lazyAttachOne(n, ctx, resolved, force)))
}

/** Why a configured location was not attached at startup. `local` and
 *  `dormant` are the quiet, expected reasons (nothing surfaced to the
 *  user); the rest flag an actionable misconfiguration on a location the
 *  user has actually engaged (made active, or given channels to
 *  auto-subscribe). */
export type StartupSkipReason = 'local' | 'dormant' | 'no-url' | 'no-tokens' | 'not-constructable'

export interface StartupAttachPlan {
  /** Non-local locations to attach, in input order. */
  attach: ResolvedLocation[]
  /** Every location that was not attached, with the reason. */
  skipped: Array<{ name: string; reason: StartupSkipReason }>
}

/**
 * Decide which non-local locations to attach at startup.
 *
 * The local broker is always handled separately by `server.ts` and is
 * never in `attach`. A non-local location is attached only when the user
 * has *engaged* it: it is the active location, or it carries configured
 * channels to auto-subscribe (the README "channels auto-subscribe on
 * startup" contract). A token-bearing remote that is neither active nor
 * channel-configured is *dormant* - it stays in the config so
 * `authenticate` can hot-attach it on demand, but it is not touched at
 * startup. That is what keeps a stale/expired remote (e.g. an old KAI
 * location) from forcing a sign-in round-trip during purely-local work.
 *
 * Engaged locations are additionally validated for constructability
 * (url + tokens + Clerk app pointer, matching `defaultTransportFactory`);
 * a misconfigured engaged location is reported with an actionable reason
 * rather than thrown.
 *
 * Pure and side-effect free so the policy can be unit-tested without
 * standing up transports.
 */
export function planStartupAttachments(
  locations: ResolvedLocation[],
  activeLocation: string | undefined,
): StartupAttachPlan {
  const attach: ResolvedLocation[] = []
  const skipped: Array<{ name: string; reason: StartupSkipReason }> = []

  for (const location of locations) {
    if (location.isLocal) {
      skipped.push({ name: location.name, reason: 'local' })
      continue
    }
    const engaged = location.name === activeLocation || location.channels.length > 0
    if (!engaged) {
      skipped.push({ name: location.name, reason: 'dormant' })
      continue
    }
    if (!location.url) {
      skipped.push({ name: location.name, reason: 'no-url' })
      continue
    }
    if (!location.accessToken || !location.refreshToken) {
      skipped.push({ name: location.name, reason: 'no-tokens' })
      continue
    }
    if (!location.clerkIssuer || !location.clerkClientId) {
      skipped.push({ name: location.name, reason: 'not-constructable' })
      continue
    }
    attach.push(location)
  }

  return { attach, skipped }
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
  // Fail closed on a non-HTTPS (and non-loopback) deployment URL: the OIDC ID
  // token is attached to this Convex client, so a mistyped `http://` host would
  // otherwise leak a ~24h credential over plaintext ws://. The Clerk token
  // endpoints have their own guard; this covers the Convex URL itself.
  assertSecureBearerUrl(new URL(location.url), `Convex location URL ("${location.name}")`)
  const client = createRemoteClient({
    locationName: location.name,
    url: location.url,
    accessToken: location.accessToken ?? '',
    idToken: location.idToken ?? '',
    refreshToken: location.refreshToken ?? '',
    accessTokenExpiresAt: location.accessTokenExpiresAt,
    clerkIssuer: location.clerkIssuer,
    clerkClientId: location.clerkClientId,
    userEmail: location.userEmail,
    userId: location.userId,
  })
  return new RemoteTransport({ client, source: location.name })
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

/** Type guard: does this transport carry a per-channel delivery cursor that a
 *  deliberate `leave_channel` should forget? Only remote transports do; the
 *  local broker replays nothing on re-join. */
export function hasChannelCursor(transport: Transport): transport is Transport & {
  forgetChannelCursor: RemoteTransport['forgetChannelCursor']
} {
  return typeof (transport as { forgetChannelCursor?: unknown }).forgetChannelCursor === 'function'
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
