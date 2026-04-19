import type { SessionManager } from '../session.js'
import type { ActiveContext } from '../context.js'
import { normalizeChannelName } from '../context.js'

export interface ChannelToolDeps {
  session: SessionManager
  context: ActiveContext
  brokerPort: number
}

function brokerBaseUrl(port: number): string {
  return `http://localhost:${port}`
}

async function brokerFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Broker request failed (${res.status}): ${body}`)
  }
  return res.json() as Promise<T>
}

const NO_NAME_ERROR = JSON.stringify({
  error:
    'No name set. Call introduce first (e.g. "architect", "frontend"). If the user has not specified a name, ASK THE USER what name this session should use before proceeding.',
})

export function createChannelTools() {
  return [
    {
      name: 'list_channels',
      description: 'Return subscribed channels as JSON array: [{name, source, subscriberCount, isActive}].',
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
  const counts = new Map<string, number>()
  try {
    const data = await brokerFetch<{ channels: Array<{ name: string; subscriberCount: number }> }>(
      `${brokerBaseUrl(deps.brokerPort)}/channels?sessionId=${encodeURIComponent(deps.session.displayName)}`,
    )
    for (const c of data.channels) counts.set(c.name, c.subscriberCount)
  } catch {
    // Broker unreachable: fall back to 1 (at least this session).
  }

  const active = deps.context.getActiveChannel()
  const result = subscribed.map((c) => ({
    name: c.name,
    source: c.source,
    subscriberCount: counts.get(c.name) ?? 1,
    isActive: c.name === active,
  }))
  return JSON.stringify(result)
}

async function handleJoinChannel(deps: ChannelToolDeps, rawName: string): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })

  const data = await brokerFetch<{ subscriberCount?: number }>(`${brokerBaseUrl(deps.brokerPort)}/channels/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: deps.session.displayName, channel: normalized }),
  })
  const { becameActive } = deps.context.joinChannel(normalized, 'manual')
  return JSON.stringify({
    channel: normalized,
    becameActive,
    subscriberCount: data.subscriberCount ?? 1,
  })
}

async function handleLeaveChannel(deps: ChannelToolDeps, rawName: string): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return JSON.stringify({ error: 'Channel name must be non-empty.' })
  if (!deps.context.isChannelSubscribed(normalized)) {
    return JSON.stringify({ error: `Not subscribed to "${normalized}".` })
  }

  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/channels/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: deps.session.displayName, channel: normalized }),
  })
  const { removed, newActive } = deps.context.leaveChannel(normalized)
  return JSON.stringify({
    channel: normalized,
    removed,
    newActiveChannel: newActive ?? null,
  })
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

  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sender: deps.session.displayName, channel: target }),
  })
  return JSON.stringify({ channel: target })
}
