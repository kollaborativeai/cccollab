import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'
import type { SubscriptionManager } from '../subscriptions.js'

export interface ChannelToolDeps {
  session: SessionManager
  webClient: WebClient
  subscriptionManager: SubscriptionManager
}

export function createChannelTools() {
  return [
    {
      name: 'subscribe_channel',
      description: 'Join a Slack channel and start receiving pushed events from it.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          read_history: { type: 'boolean' as const, description: 'Read recent history (default: true)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'unsubscribe_channel',
      description: 'Stop receiving events from a channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          post_departure: { type: 'boolean' as const, description: 'Post departure message (default: true)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'list_subscriptions',
      description: 'List all channels this session is subscribed to.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ]
}

export async function handleChannelTool(
  name: string, args: Record<string, unknown>, deps: ChannelToolDeps
): Promise<string> {
  switch (name) {
    case 'subscribe_channel': {
      const { channel, read_history } = args as { channel: string; read_history?: boolean }
      const { channelId, alreadySubscribed } = await deps.subscriptionManager.join(channel)
      await deps.webClient.chat.postMessage({
        channel: channelId,
        text: `:robot_face: *[${deps.session.sessionName}]* joined the channel`,
      })
      const lines = [`Subscribed to #${channel}${alreadySubscribed ? ' (was already subscribed)' : ''}`]
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
    case 'unsubscribe_channel': {
      const { channel, post_departure } = args as { channel: string; post_departure?: boolean }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      if (post_departure !== false) {
        await deps.webClient.chat.postMessage({
          channel: channelId,
          text: `:wave: *[${deps.session.sessionName}]* left the channel`,
        })
      }
      deps.subscriptionManager.leave(channelId)
      return `Unsubscribed from #${channel}.`
    }
    case 'list_subscriptions': {
      const ids = deps.subscriptionManager.getSubscriptions()
      if (ids.length === 0) return 'No active subscriptions.'
      const lines = ['Active subscriptions:']
      for (const id of ids) {
        lines.push(`  - #${deps.subscriptionManager.getChannelName(id) ?? id}`)
      }
      return lines.join('\n')
    }
    default:
      throw new Error(`Unknown channel tool: ${name}`)
  }
}
