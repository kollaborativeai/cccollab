import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'
import type { SubscriptionManager } from '../subscriptions.js'
import type { ActiveContext } from '../context.js'

export interface ChannelToolDeps {
  session: SessionManager
  webClient: WebClient
  subscriptionManager: SubscriptionManager
  context: ActiveContext
}

export function createChannelTools() {
  return [
    {
      name: 'join_channel',
      description: 'Join a Slack channel, subscribe, set it as the active channel, show recent history, and announce presence.',
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
      description: 'Leave the active channel (or a specified channel) and clear the active context.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name (optional - if omitted, leaves the active channel)' },
        },
        required: [],
      },
    },
    {
      name: 'list_channels',
      description: 'Show all subscribed channels and mark which one is active.',
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
      const { channelId, alreadySubscribed } = await deps.subscriptionManager.join(channel)
      deps.context.setChannel(channelId, channel)
      await deps.webClient.chat.postMessage({
        channel: channelId,
        text: `:robot_face: *[${deps.session.sessionName}]* joined the channel`,
      })
      const lines = [`Joined #${channel}${alreadySubscribed ? ' (was already subscribed)' : ''}. This is now your active channel.`]
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
      await deps.webClient.chat.postMessage({
        channel: channelId,
        text: `:wave: *[${deps.session.sessionName}]* left the channel`,
      })
      deps.subscriptionManager.leave(channelId)
      deps.context.clearChannel()
      return `Left #${channelName}.`
    }
    case 'list_channels': {
      const ids = deps.subscriptionManager.getSubscriptions()
      if (ids.length === 0) return 'No subscribed channels.'
      const activeChannelId = deps.context.hasChannel() ? deps.context.getChannelId() : undefined
      const lines = ['Subscribed channels:']
      for (const id of ids) {
        const name = deps.subscriptionManager.getChannelName(id) ?? id
        const isActive = id === activeChannelId
        lines.push(`  ${isActive ? '* ' : '  '}#${name}${isActive ? ' (active)' : ''}`)
      }
      return lines.join('\n')
    }
    default:
      throw new Error(`Unknown channel tool: ${name}`)
  }
}
