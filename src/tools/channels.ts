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

export function createChannelTools() {
  return [
    {
      name: 'list_channels',
      description: 'List channels you are subscribed to, each with subscriber count and source (manual, fallback, env, cccollab.json). Marks the active channel.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'join_channel',
      description: 'Subscribe to a channel (implicitly created on first subscription). Idempotent. If you had no active channel, this becomes the active one; otherwise your active channel is unchanged.',
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
      description: 'Unsubscribe from a channel. If it was your active channel, the first of your remaining subscribed channels becomes active (or none if you have none left).',
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
      description: 'Set your active channel. You must already be subscribed to it.',
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
      description: 'Send a top-level broadcast to a channel (not in a topic). Defaults to your active channel.',
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
  name: string, args: Record<string, unknown>, deps: ChannelToolDeps,
): Promise<string> {
  if (REQUIRES_NAME.has(name) && !deps.session.hasName()) {
    return 'This session has no name set. Call `introduce` first with a name (e.g., "architect", "frontend"). If the user has not specified a name, ASK THE USER what name this session should use before proceeding.'
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
  if (subscribed.length === 0) return 'No channels subscribed.'

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
  const lines = ['Subscribed channels:']
  for (const c of subscribed) {
    const marker = c.name === active ? ' [active]' : ''
    const count = counts.get(c.name) ?? 1
    lines.push(`  #${c.name} - ${count} subscriber${count === 1 ? '' : 's'} (source: ${c.source})${marker}`)
  }
  return lines.join('\n')
}

async function handleJoinChannel(deps: ChannelToolDeps, rawName: string): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return 'Error: channel name must be non-empty.'

  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/channels/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: deps.session.displayName, channel: normalized }),
  })
  const { becameActive } = deps.context.joinChannel(normalized, 'manual')
  return becameActive
    ? `Joined #${normalized}. This is now your active channel.`
    : `Joined #${normalized}. Active channel unchanged (#${deps.context.getActiveChannel() ?? 'none'}).`
}

async function handleLeaveChannel(deps: ChannelToolDeps, rawName: string): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return 'Error: channel name must be non-empty.'
  if (!deps.context.isChannelSubscribed(normalized)) {
    return `Not subscribed to #${normalized}.`
  }

  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/channels/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: deps.session.displayName, channel: normalized }),
  })
  const { newActive } = deps.context.leaveChannel(normalized)
  if (!newActive) return `Left #${normalized}. No active channel.`
  return `Left #${normalized}. Active channel is now #${newActive}.`
}

async function handleSetActiveChannel(deps: ChannelToolDeps, rawName: string): Promise<string> {
  const normalized = normalizeChannelName(rawName)
  if (!normalized) return 'Error: channel name must be non-empty.'
  if (!deps.context.isChannelSubscribed(normalized)) {
    return `Not subscribed to #${normalized}. Use join_channel first.`
  }
  deps.context.setActiveChannel(normalized)
  return `Active channel set to #${normalized}.`
}

async function handleSendMessageToChannel(
  deps: ChannelToolDeps, args: { text?: string; channel?: string },
): Promise<string> {
  const text = args.text
  if (typeof text !== 'string' || text.trim() === '') {
    return 'Error: `text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)'
  }

  let target = args.channel ? normalizeChannelName(args.channel) : undefined
  if (!target) target = deps.context.getActiveChannel()
  if (!target) {
    return 'No active channel. Join a channel first with join_channel, or pass a `channel` argument.'
  }
  if (!deps.context.isChannelSubscribed(target)) {
    return `Not subscribed to #${target}. Use join_channel first.`
  }

  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sender: deps.session.displayName, channel: target }),
  })
  return `Broadcast sent in #${target}.`
}
