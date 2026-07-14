import type { ActiveContext, ChannelSource } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import type { ChannelLocation } from '../transport/index.js'
import type { TransportRouter } from '../transport/router.js'
import { ensureChannelSubscription, hasChannelCursor, teardownChannelSubscription } from '../transport/attach.js'
import { normalizeChannelName } from '../context.js'

export interface ChannelToolDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  /** Inbound message pipeline. Optional so legacy tests that don't
   *  exercise remote broadcast subscriptions can keep constructing deps
   *  without one; wiring degrades to a no-op when absent. */
  messageBus?: MessageBus
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
      const { name: rawName, location } = args as { name?: string; location?: ChannelLocation }
      return handleJoinChannel(deps, rawName ?? '', location ?? 'local')
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
    })
  }

  return JSON.stringify({
    activeChannel: active ? { name: active.name, location: active.location } : null,
    channels,
  })
}

async function handleJoinChannel(deps: ChannelToolDeps, rawName: string, location: ChannelLocation): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })

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
  const { becameActive } = deps.context.joinChannel(normalized, 'manual', location)
  if (deps.messageBus) {
    ensureChannelSubscription({ transport, channelName: normalized, messageBus: deps.messageBus })
  }
  return JSON.stringify({ channel: normalized, location, becameActive, subscriberCount })
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
  // A DELIBERATE leave: forget the channel's feed (and the feeds of the topics
  // inside it) outright, rather than leaving them suspended as the transport
  // does for the migration's transient leave.
  teardownChannelSubscription({ transport, channelName: normalized })
  // Deliberately leaving a channel forgets its delivery cursor, so a later
  // re-join re-seeds from the channel's latestTs and skips the backlog that
  // accrued while away. The identity migration's transient leave/re-join must
  // NOT do this - it keeps its place in the stream so no broadcast that lands
  // mid-rename is dropped - which is why this lives here and not in
  // `RemoteTransport.leaveChannel`, which both paths share.
  if (hasChannelCursor(transport)) transport.forgetChannelCursor(normalized)
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
