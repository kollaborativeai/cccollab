import type { ActiveContext, ChannelSource } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import { LOCAL_LOCATION, type ChannelLocation } from '../transport/index.js'
import type { TransportRouter } from '../transport/router.js'
import { ensureChannelSubscription, teardownChannelSubscription } from '../transport/attach.js'
import { normalizeChannelName } from '../context.js'

export interface ChannelToolDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  /** Inbound message pipeline. Optional so legacy tests that don't
   *  exercise remote broadcast subscriptions can keep constructing deps
   *  without one; wiring degrades to a no-op when absent. */
  messageBus?: MessageBus
  /** Shared map of channel-broadcast subscription unsubscribe callbacks,
   *  keyed by `${location}::${channelName}`. Populated on join_channel,
   *  drained on leave_channel. Shutdown + replace-in-place drain is
   *  handled by `server.ts` and `attachLocation` respectively. */
  remoteChannelUnsubscribes?: Map<string, () => void>
  /** Bring a dormant token-bearing location online before routing to it,
   *  so a remote in config works without a fresh `authenticate`. `target`
   *  names a location; omit for "every non-local". No-op for 'local' and
   *  already-attached locations. Optional so legacy unit tests that build
   *  deps by hand keep compiling. See `ensureLazyAttach`. */
  ensureAttached?: (target?: string, opts?: { force?: boolean }) => Promise<void>
}

const NO_NAME_ERROR = JSON.stringify({
  error:
    'No name set. Call introduce first (e.g. "architect", "frontend"). If the user has not specified a name, ASK THE USER what name this session should use before proceeding.',
})

const REQUIRES_NAME = new Set(['join_channel', 'leave_channel', 'set_active_channel', 'send_message_to_channel'])

export async function handleChannelTool(
  name: string,
  args: Record<string, unknown>,
  deps: ChannelToolDeps,
): Promise<string> {
  if (REQUIRES_NAME.has(name) && !deps.session.hasName()) {
    return NO_NAME_ERROR
  }

  switch (name) {
    case 'list_channels': {
      const { location } = args as { location?: ChannelLocation }
      return handleListChannels(deps, location)
    }
    case 'join_channel': {
      const { name: rawName, location, watch } = args as { name?: string; location?: ChannelLocation; watch?: boolean }
      // `location` is passed through UNDEFAULTED: handleJoinChannel must be
      // able to tell "the caller chose local" from "the caller said nothing",
      // because a watch with an unstated location is ambiguous and dangerous.
      return handleJoinChannel(deps, rawName ?? '', location, watch)
    }
    case 'leave_channel': {
      const { name: rawName, location } = args as { name?: string; location?: ChannelLocation }
      return handleLeaveChannel(deps, rawName ?? '', location ?? 'local')
    }
    case 'set_active_channel': {
      const { name: rawName, location } = args as { name?: string; location?: ChannelLocation }
      return handleSetActiveChannel(deps, rawName ?? '', location ?? 'local')
    }
    case 'send_message_to_channel':
      return handleSendMessageToChannel(deps, args as { text?: string; channel?: string; location?: ChannelLocation })
    case 'read_channel_messages': {
      const { channel, location, limit, before } = args as {
        channel?: string
        location?: ChannelLocation
        limit?: number
        before?: number
      }
      let targetName: string | undefined = channel ? normalizeChannelName(channel) : undefined
      let targetLocation: ChannelLocation | undefined = location
      if (!targetName) {
        const active = deps.context.getActiveChannelRef()
        if (active) {
          targetName = active.name
          targetLocation = active.location
        }
      }
      if (!targetName) {
        return JSON.stringify({
          error: 'No active channel. Pass a `channel`, or join one with join_channel.',
        })
      }
      targetLocation = targetLocation ?? deps.context.getChannelLocation(targetName) ?? 'local'
      await deps.ensureAttached?.(targetLocation)
      let transport
      try {
        transport = deps.router.get(targetLocation)
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      }
      const page = await transport.readChannelMessages({
        channel: targetName,
        limit,
        before,
      })
      return JSON.stringify(page)
    }
    default:
      throw new Error(`Unknown channel tool: ${name}`)
  }
}

interface ChannelRow {
  name: string
  location: ChannelLocation
  source: ChannelSource | null
  /** Distinct users subscribed to the channel. */
  subscriberCount: number
  /** Sessions joined to the channel (>= `subscriberCount`; one user may have
   *  several sessions). Undefined when the transport cannot report it. */
  sessionCount?: number
  messageCount?: number
  subscribed: boolean
  isActive: boolean
  /** Channel-wide topic visibility (KAI-414). Surfaced here as well as in
   *  `whoami` because this is the other place a session looks to answer
   *  "am I actually seeing this channel?". */
  watching: boolean
}

async function handleListChannels(deps: ChannelToolDeps, locationFilter?: ChannelLocation): Promise<string> {
  await deps.ensureAttached?.(locationFilter)
  const subscribed = deps.context.getSubscribedChannels()
  const subscribedByKey = new Map(subscribed.map((c) => [`${c.location}::${c.name}`, c]))
  const active = deps.context.getActiveChannelRef()

  const transports = deps.router.enabled().filter((t) => !locationFilter || t.source === locationFilter)

  const seen = new Set<string>()
  const channels: ChannelRow[] = []

  for (const transport of transports) {
    let rows: Array<{
      name: string
      subscriberCount: number
      sessionCount?: number
      messageCount?: number
    }> = []
    try {
      rows = await transport.listChannels({})
    } catch {
      // Transport unreachable: skip; we still surface its subscribed
      // channels below so the caller doesn't "lose" a channel.
    }
    for (const c of rows) {
      const key = `${transport.source}::${c.name}`
      seen.add(key)
      const sub = subscribedByKey.get(key)
      channels.push({
        name: c.name,
        location: transport.source,
        source: sub ? sub.source : null,
        subscriberCount: c.subscriberCount,
        sessionCount: c.sessionCount,
        messageCount: c.messageCount,
        subscribed: sub !== undefined,
        isActive: active?.name === c.name && active?.location === transport.source,
        watching: sub?.watching === true,
      })
    }
  }

  // Subscribed channels the transport didn't report (e.g. transport
  // down, or a transient race): still surface them so the caller never
  // "loses" a channel it knows it subscribed to.
  for (const sub of subscribed) {
    if (locationFilter && sub.location !== locationFilter) continue
    const key = `${sub.location}::${sub.name}`
    if (seen.has(key)) continue
    channels.push({
      name: sub.name,
      location: sub.location,
      source: sub.source,
      // Transport didn't report this channel, but the caller is subscribed —
      // so at minimum this session, and its owner, are in it.
      subscriberCount: 1,
      sessionCount: 1,
      messageCount: undefined,
      subscribed: true,
      isActive: active?.name === sub.name && active?.location === sub.location,
      watching: sub.watching,
    })
  }

  return JSON.stringify({
    activeChannel: active ? { name: active.name, location: active.location } : null,
    channels,
  })
}

async function handleJoinChannel(
  deps: ChannelToolDeps,
  rawName: string,
  requestedLocation: ChannelLocation | undefined,
  watch?: boolean,
): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })

  const location = requestedLocation ?? LOCAL_LOCATION

  // Remote delivers topic messages via per-topic subscriptions, so a watched
  // remote channel would silently miss every topic created after the join —
  // the exact blind spot watch mode exists to close. Refuse loudly until the
  // remote topic-created event (KAI-413) lands. Fail BEFORE joining: a
  // half-applied watch is worse than none.
  if (watch === true && location !== LOCAL_LOCATION) {
    return JSON.stringify({
      error:
        `Channel-wide watch is local-transport only; "${location}" is remote. ` +
        `Remote watch needs the topic-created event (KAI-413), which is not ready. ` +
        `Re-run without \`watch\` to subscribe normally.`,
    })
  }

  // A watch with an UNSTATED location is the nastiest case of all: `location`
  // silently defaults to local and join_channel implicitly creates channels,
  // so an orchestrator whose fleet lives on a remote would get a brand-new,
  // empty LOCAL channel of the same name, a success response, and
  // `watching: true` — then sit in an empty room hearing nothing while whoami
  // reports it is watching. Confidently blind, which is the precise failure
  // this feature exists to eliminate. When any remote is in play, make the
  // caller say which one they mean.
  if (watch === true && requestedLocation === undefined) {
    const remotes = deps.router.enabled().filter((t) => t.source !== LOCAL_LOCATION)
    if (remotes.length > 0) {
      const names = remotes.map((t) => t.source).join(', ')
      return JSON.stringify({
        error:
          `Ambiguous watch: \`location\` was not specified and non-local locations exist (${names}). ` +
          `Watching would silently subscribe you to a LOCAL channel named "${normalized}", which may not be ` +
          `where your fleet is. Pass \`location\` explicitly (e.g. "local") to confirm which channel to watch.`,
      })
    }
  }

  await deps.ensureAttached?.(location)
  let transport
  try {
    transport = deps.router.get(location)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }

  const { subscriberCount } = await transport.joinChannel({
    sessionName: deps.session.displayName,
    channel: normalized,
  })
  const { becameActive, watching } = deps.context.joinChannel(normalized, 'manual', location, watch)
  if (deps.messageBus && deps.remoteChannelUnsubscribes) {
    ensureChannelSubscription({
      transport,
      locationName: location,
      channelName: normalized,
      messageBus: deps.messageBus,
      map: deps.remoteChannelUnsubscribes,
    })
  }
  return JSON.stringify({ channel: normalized, location, becameActive, subscriberCount, watching })
}

async function handleLeaveChannel(deps: ChannelToolDeps, rawName: string, location: ChannelLocation): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })
  if (!deps.context.isChannelSubscribed(normalized, location)) {
    return JSON.stringify({ error: `Not subscribed to "${normalized}" (${location}).` })
  }

  let transport
  try {
    transport = deps.router.get(location)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }

  await transport.leaveChannel({ sessionName: deps.session.displayName, channel: normalized })
  const { removed, newActive } = deps.context.leaveChannel(normalized, location)
  if (deps.remoteChannelUnsubscribes) {
    teardownChannelSubscription({
      locationName: location,
      channelName: normalized,
      map: deps.remoteChannelUnsubscribes,
    })
  }
  return JSON.stringify({
    channel: normalized,
    location,
    removed,
    newActiveChannel: newActive ? { name: newActive.name, location: newActive.location } : null,
  })
}

async function handleSetActiveChannel(
  deps: ChannelToolDeps,
  rawName: string,
  location: ChannelLocation,
): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })
  if (!deps.context.isChannelSubscribed(normalized, location)) {
    return JSON.stringify({ error: `Not subscribed to "${normalized}" (${location}). Use join_channel first.` })
  }
  deps.context.setActiveChannel(normalized, location)
  return JSON.stringify({ activeChannel: { name: normalized, location } })
}

async function handleSendMessageToChannel(
  deps: ChannelToolDeps,
  args: { text?: string; channel?: string; location?: ChannelLocation },
): Promise<string> {
  const text = args.text
  if (typeof text !== 'string' || text.trim() === '') {
    return JSON.stringify({
      error: '`text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)',
    })
  }

  // Resolve target channel + location:
  //   - explicit `channel` + explicit `location` => honour both
  //   - explicit `channel` only => infer location from subscriptions
  //   - neither => use active channel
  let targetName: string | undefined
  let targetLocation: ChannelLocation | undefined

  if (args.channel) {
    targetName = normalizeChannelName(args.channel)
    targetLocation = args.location ?? deps.context.getChannelLocation(targetName)
  } else {
    const active = deps.context.getActiveChannelRef()
    if (active) {
      targetName = active.name
      targetLocation = active.location
    }
  }

  if (!targetName) {
    return JSON.stringify({
      error: 'No active channel. Join a channel first with join_channel, or pass a `channel` argument.',
    })
  }
  if (!targetLocation) {
    return JSON.stringify({ error: `Not subscribed to "${targetName}". Use join_channel first.` })
  }
  if (!deps.context.isChannelSubscribed(targetName, targetLocation)) {
    return JSON.stringify({ error: `Not subscribed to "${targetName}" (${targetLocation}). Use join_channel first.` })
  }

  let transport
  try {
    transport = deps.router.get(targetLocation)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }

  await transport.broadcast({ sessionName: deps.session.displayName, channel: targetName, text })
  return JSON.stringify({ channel: targetName, location: targetLocation })
}
