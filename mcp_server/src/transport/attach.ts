import type { ActiveContext } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import type { ResolvedLocation } from '../config/resolve.js'
import { createRemoteClient } from '../remote/client.js'
import { RemoteTransport } from './remote.js'
import type { TransportRouter } from './router.js'
import type { Transport } from './index.js'

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
  /** cwd at the time of the attach. Threaded through so the hot-attach
   *  path can re-run `resolveConfig` against the same base. */
  cwd: string
  /** Environment variables used when re-resolving the config. Tests pass
   *  `{}`; production passes `process.env`. */
  env: NodeJS.ProcessEnv
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  messageBus: MessageBus
  /** Mutable list of DM-subscription unsubscribe callbacks. Shared with
   *  `server.ts`'s shutdown hook so every hot-attached transport is
   *  torn down on SIGTERM / stdin close / etc. */
  remoteUnsubscribes: Array<() => void>
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
  // it down first. Shutdown of the old transport is best-effort; its
  // deregisterSession should never throw (per the Transport contract).
  const prior = ctx.router.unregister(name)
  if (prior) {
    if (ctx.session.hasName()) {
      try {
        await prior.deregisterSession({ sessionName: ctx.session.displayName })
      } catch {
        // best-effort teardown; continue
      }
    }
    // Nothing else on the prior transport to clean up here - the DM
    // unsubscribes live in `remoteUnsubscribes` and are invoked at
    // process shutdown. We can't cheaply identify which slot belonged
    // to the prior transport; leaving them in place is safe because the
    // client underneath is now idle.
  }
  ctx.router.register(transport)

  // Step 6: DM subscription, if this transport supports one.
  if (hasDirectMessageSubscription(transport)) {
    try {
      const unsub = transport.subscribeDirectMessages((msg) => {
        void ctx.messageBus.push(msg, transport.source)
      })
      ctx.remoteUnsubscribes.push(unsub)
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
          if (found) {
            await transport.joinTopic({ sessionName: displayName, topicId: found.id })
            ctx.context.joinTopic(found.id, topic.name, channel.name, name)
          } else {
            const created = await transport.createTopic({
              sessionName: displayName,
              channel: channel.name,
              topic: topic.name,
            })
            ctx.context.joinTopic(created.id, topic.name, channel.name, name)
          }
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
  const client = createRemoteClient({
    locationName: location.name,
    url: location.url,
    accessToken: location.accessToken ?? '',
    refreshToken: location.refreshToken ?? '',
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

function logError(message: string): void {
  process.stderr.write(`[cccollab] ${message}\n`)
}
