import type { ActiveContext, ChannelSource } from '../context.js'
import type { SessionManager } from '../session.js'
import type { ChannelLocation } from '../transport/index.js'
import type { TransportRouter } from '../transport/router.js'
import { normalizeChannelName } from '../context.js'

export interface ChannelToolDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
}

const NO_NAME_ERROR = JSON.stringify({
  error:
    'No name set. Call introduce first (e.g. "architect", "frontend"). If the user has not specified a name, ASK THE USER what name this session should use before proceeding.',
})

export function createChannelTools() {
  return [
    {
      name: 'list_channels',
      description:
        'Return all channels visible across all enabled transports with subscription and active status. Returns {activeChannel, channels: [{name, location, subscriberCount, subscribed, source, isActive}]}. `location` is "local" or "remote". `source` is the ChannelSource for subscribed channels, null otherwise. `activeChannel` is {name, location} or null. Optional `location` arg restricts the view to one transport.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          location: {
            type: 'string' as const,
            enum: ['local', 'remote'],
            description: 'Restrict to a single location. Omit to list across all enabled locations.',
          },
        },
      },
    },
    {
      name: 'join_channel',
      description:
        'Subscribe to a channel (implicitly created). Idempotent. `location` selects the transport ("local" = in-process broker, "remote" = Convex deployment). Returns {channel, location, becameActive, subscriberCount}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Channel name (case-insensitive, non-empty).' },
          location: {
            type: 'string' as const,
            enum: ['local', 'remote'],
            description: 'Transport location. Defaults to "local".',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'leave_channel',
      description:
        'Unsubscribe from a channel at the given location. Returns {channel, location, removed, newActiveChannel}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Channel name to leave.' },
          location: {
            type: 'string' as const,
            enum: ['local', 'remote'],
            description: 'Transport location. Defaults to "local".',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'set_active_channel',
      description: 'Set your active channel. Returns {activeChannel: {name, location}}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Channel name (must be subscribed).' },
          location: {
            type: 'string' as const,
            enum: ['local', 'remote'],
            description: 'Transport location. Defaults to "local".',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'send_message_to_channel',
      description:
        'Send a top-level broadcast to a channel (not in a topic). Defaults to active channel. Returns {channel, location}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'Message text' },
          channel: { type: 'string' as const, description: 'Channel name. Defaults to the active channel.' },
          location: {
            type: 'string' as const,
            enum: ['local', 'remote'],
            description:
              'Transport location of the target channel. Defaults to the active channel\'s location, or "local".',
          },
        },
        required: ['text'],
      },
    },
  ]
}

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
    default:
      throw new Error(`Unknown channel tool: ${name}`)
  }
}

interface ChannelRow {
  name: string
  location: ChannelLocation
  source: ChannelSource | null
  subscriberCount: number
  subscribed: boolean
  isActive: boolean
}

async function handleListChannels(deps: ChannelToolDeps, locationFilter?: ChannelLocation): Promise<string> {
  const subscribed = deps.context.getSubscribedChannels()
  const subscribedByKey = new Map(subscribed.map((c) => [`${c.location}::${c.name}`, c]))
  const active = deps.context.getActiveChannelRef()

  const transports = deps.router.enabled().filter((t) => !locationFilter || t.source === locationFilter)

  const seen = new Set<string>()
  const channels: ChannelRow[] = []

  for (const transport of transports) {
    let rows: Array<{ name: string; subscriberCount: number }> = []
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
      subscriberCount: 1,
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

  let transport
  try {
    transport = deps.router.getByLocation(location)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }

  const { subscriberCount } = await transport.joinChannel({
    sessionName: deps.session.displayName,
    channel: normalized,
  })
  const { becameActive } = deps.context.joinChannel(normalized, 'manual', location)
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
    transport = deps.router.getByLocation(location)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }

  await transport.leaveChannel({ sessionName: deps.session.displayName, channel: normalized })
  const { removed, newActive } = deps.context.leaveChannel(normalized, location)
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
    transport = deps.router.getByLocation(targetLocation)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }

  await transport.broadcast({ sessionName: deps.session.displayName, channel: targetName, text })
  return JSON.stringify({ channel: targetName, location: targetLocation })
}
