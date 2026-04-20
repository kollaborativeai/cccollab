import type { ActiveContext, ChannelSource } from '../context.js'
import type { SessionManager } from '../session.js'
import type { Transport } from '../transport/index.js'
import { normalizeChannelName } from '../context.js'

export interface ChannelToolDeps {
  session: SessionManager
  context: ActiveContext
  transport: Transport
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
        'Return all channels visible on the broker with subscription and active status. Returns {activeChannel, channels: [{name, subscriberCount, subscribed, source, isActive}]}. `source` is the ChannelSource for subscribed channels, null otherwise. `activeChannel` is your active channel name or null. Use this to discover channels you could join (subscribed:false) as well as those you are already in.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'join_channel',
      description:
        'Subscribe to a channel (implicitly created). Idempotent. Returns {channel, becameActive, subscriberCount}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Channel name (case-insensitive, non-empty).' },
        },
        required: ['name'],
      },
    },
    {
      name: 'leave_channel',
      description: 'Unsubscribe from a channel. Returns {channel, removed, newActiveChannel}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Channel name to leave.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'set_active_channel',
      description: 'Set your active channel. Returns {activeChannel}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Channel name (must be subscribed).' },
        },
        required: ['name'],
      },
    },
    {
      name: 'send_message_to_channel',
      description:
        'Send a top-level broadcast to a channel (not in a topic). Defaults to active channel. Returns {channel}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'Message text' },
          channel: { type: 'string' as const, description: 'Channel name. Defaults to the active channel.' },
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
    case 'list_channels':
      return handleListChannels(deps)
    case 'join_channel':
      return handleJoinChannel(deps, (args.name as string | undefined) ?? '')
    case 'leave_channel':
      return handleLeaveChannel(deps, (args.name as string | undefined) ?? '')
    case 'set_active_channel':
      return handleSetActiveChannel(deps, (args.name as string | undefined) ?? '')
    case 'send_message_to_channel':
      return handleSendMessageToChannel(deps, args as { text?: string; channel?: string })
    default:
      throw new Error(`Unknown channel tool: ${name}`)
  }
}

async function handleListChannels(deps: ChannelToolDeps): Promise<string> {
  const subscribed = deps.context.getSubscribedChannels()
  const subscribedByName = new Map(subscribed.map((c) => [c.name, c]))
  const active = deps.context.getActiveChannel()

  // Broker-global view: no sessionId filter => returns ALL channels.
  let brokerChannels: Array<{ name: string; subscriberCount: number }> = []
  try {
    brokerChannels = await deps.transport.listChannels({})
  } catch {
    // Broker unreachable: degrade gracefully to subscribed-only view below.
  }

  const seen = new Set<string>()
  const channels: Array<{
    name: string
    source: ChannelSource | null
    subscriberCount: number
    subscribed: boolean
    isActive: boolean
  }> = []

  for (const c of brokerChannels) {
    seen.add(c.name)
    const sub = subscribedByName.get(c.name)
    channels.push({
      name: c.name,
      source: sub ? sub.source : null,
      subscriberCount: c.subscriberCount,
      subscribed: sub !== undefined,
      isActive: c.name === active,
    })
  }

  // Locally-subscribed channels the broker didn't report (e.g. broker down,
  // or a transient race): still surface them so the caller never "loses" a
  // channel it knows it subscribed to.
  for (const sub of subscribed) {
    if (seen.has(sub.name)) continue
    channels.push({
      name: sub.name,
      source: sub.source,
      subscriberCount: 1,
      subscribed: true,
      isActive: sub.name === active,
    })
  }

  return JSON.stringify({ activeChannel: active ?? null, channels })
}

async function handleJoinChannel(deps: ChannelToolDeps, rawName: string): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })

  const { subscriberCount } = await deps.transport.joinChannel({
    sessionName: deps.session.displayName,
    channel: normalized,
  })
  const { becameActive } = deps.context.joinChannel(normalized, 'manual')
  return JSON.stringify({ channel: normalized, becameActive, subscriberCount })
}

async function handleLeaveChannel(deps: ChannelToolDeps, rawName: string): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })
  if (!deps.context.isChannelSubscribed(normalized)) {
    return JSON.stringify({ error: `Not subscribed to "${normalized}".` })
  }

  await deps.transport.leaveChannel({ sessionName: deps.session.displayName, channel: normalized })
  const { removed, newActive } = deps.context.leaveChannel(normalized)
  return JSON.stringify({ channel: normalized, removed, newActiveChannel: newActive ?? null })
}

async function handleSetActiveChannel(deps: ChannelToolDeps, rawName: string): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })
  if (!deps.context.isChannelSubscribed(normalized)) {
    return JSON.stringify({ error: `Not subscribed to "${normalized}". Use join_channel first.` })
  }
  deps.context.setActiveChannel(normalized)
  return JSON.stringify({ activeChannel: normalized })
}

async function handleSendMessageToChannel(
  deps: ChannelToolDeps,
  args: { text?: string; channel?: string },
): Promise<string> {
  const text = args.text
  if (typeof text !== 'string' || text.trim() === '') {
    return JSON.stringify({
      error: '`text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)',
    })
  }

  let target = args.channel ? normalizeChannelName(args.channel) : undefined
  if (!target) target = deps.context.getActiveChannel()
  if (!target) {
    return JSON.stringify({
      error: 'No active channel. Join a channel first with join_channel, or pass a `channel` argument.',
    })
  }
  if (!deps.context.isChannelSubscribed(target)) {
    return JSON.stringify({ error: `Not subscribed to "${target}". Use join_channel first.` })
  }

  await deps.transport.broadcast({ sessionName: deps.session.displayName, channel: target, text })
  return JSON.stringify({ channel: target })
}
