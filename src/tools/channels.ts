import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'
import type { SubscriptionManager } from '../subscriptions.js'
import type { ActiveContext } from '../context.js'

export interface ChannelToolDeps {
  session: SessionManager
  webClient: WebClient
  postClient: WebClient
  subscriptionManager: SubscriptionManager
  context: ActiveContext
}

export function createChannelTools() {
  return [
    {
      name: 'join_channel',
      description: 'Join a Slack channel and set it as the active channel. Shows recent history.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          read_history: { type: 'boolean' as const, description: 'Show recent history (default: true)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'leave_channel',
      description: 'Leave a Slack channel. Defaults to the active channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name. Defaults to active channel.' },
        },
        required: [],
      },
    },
    {
      name: 'list_channels',
      description: 'List all available channels the bot has access to. The active channel is marked.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ]
}

export async function handleChannelTool(
  name: string, args: Record<string, unknown>, deps: ChannelToolDeps
): Promise<string> {
  switch (name) {
    case 'join_channel': {
      const { channel, read_history } = args as { channel: string; read_history?: boolean }

      const { channelId } = await deps.subscriptionManager.join(channel)
      deps.context.setActiveChannel(channelId, channel)

      const lines = [`Joined #${channel}. This is now your active channel.`]
      if (read_history !== false) {
        const history = await deps.webClient.conversations.history({ channel: channelId, limit: 20 })
        if (history.messages && history.messages.length > 0) {
          lines.push('', 'Recent messages:')
          for (const msg of history.messages.reverse()) {
            lines.push(`  ${msg.text ?? '(empty)'}`)
          }
        }
      }
      return lines.join('\n')
    }
    case 'leave_channel': {
      const { channel } = args as { channel?: string }
      let channelId: string
      let channelName: string
      if (channel) {
        channelId = await deps.subscriptionManager.resolveChannelId(channel)
        channelName = channel
      } else {
        channelId = deps.context.getChannelId()
        channelName = deps.context.getChannelName()
      }
      deps.subscriptionManager.leave(channelId)
      deps.context.leaveSlackChannel(channelId)
      return `Left #${channelName}.`
    }
    case 'list_channels': {
      // Load all channels the bot can see
      const allChannels: Array<{ id: string; name: string; is_private: boolean; is_member: boolean }> = []
      let cursor: string | undefined
      do {
        const result = await deps.webClient.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        })
        for (const ch of result.channels ?? []) {
          if (ch.id && ch.name && ch.is_member) {
            allChannels.push({
              id: ch.id,
              name: ch.name,
              is_private: ch.is_private ?? false,
              is_member: true,
            })
          }
        }
        cursor = result.response_metadata?.next_cursor || undefined
      } while (cursor)

      if (allChannels.length === 0) return 'No channels found.'

      const activeChannelId = deps.context.hasChannel() ? deps.context.getChannelId() : undefined

      const lines = ['Available channels:']
      lines.push('  #local (always joined)')
      for (const ch of allChannels.sort((a, b) => a.name.localeCompare(b.name))) {
        const isActive = ch.id === activeChannelId
        const lock = ch.is_private ? ' (private)' : ''
        const active = isActive ? ' <-- active' : ''
        lines.push(`  #${ch.name}${lock}${active}`)
      }
      return lines.join('\n')
    }
    default:
      throw new Error(`Unknown channel tool: ${name}`)
  }
}
