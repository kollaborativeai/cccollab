import type { WebClient } from '@slack/web-api'
import type { SubscriptionManager } from '../subscriptions.js'
import { SessionManager } from '../session.js'

export interface ConversationToolDeps {
  session: SessionManager
  webClient: WebClient
  subscriptionManager: SubscriptionManager
}

const TOPIC_PATTERN = /^:(large_green_circle|white_check_mark): TOPIC: (.+?) \| \*\[(.+?)\]\*$/

export function createConversationTools() {
  return [
    {
      name: 'start_conversation',
      description: 'Start a new conversation (thread) in a team channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          topic: { type: 'string' as const, description: 'Conversation topic' },
          detail: { type: 'string' as const, description: 'Additional detail' },
          participants_needed: { type: 'string' as const, description: 'Roles or people needed' },
        },
        required: ['channel', 'topic'],
      },
    },
    {
      name: 'join_conversation',
      description: 'Join an existing conversation. Fetches history and announces presence.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          thread_ts: { type: 'string' as const, description: 'Thread timestamp (conversation ID)' },
        },
        required: ['channel', 'thread_ts'],
      },
    },
    {
      name: 'reply_in_conversation',
      description: 'Post a reply in an existing conversation thread.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          thread_ts: { type: 'string' as const, description: 'Thread timestamp' },
          text: { type: 'string' as const, description: 'Message text' },
        },
        required: ['channel', 'thread_ts', 'text'],
      },
    },
    {
      name: 'list_conversations',
      description: 'List conversations in a channel with topic, author, reply count, and status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          include_resolved: { type: 'boolean' as const, description: 'Include resolved conversations (default: false)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'resolve_conversation',
      description: 'Mark a conversation as resolved with a summary.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          thread_ts: { type: 'string' as const, description: 'Thread timestamp' },
          summary: { type: 'string' as const, description: 'Resolution summary' },
        },
        required: ['channel', 'thread_ts', 'summary'],
      },
    },
  ]
}

export async function handleConversationTool(
  name: string, args: Record<string, unknown>, deps: ConversationToolDeps
): Promise<string> {
  switch (name) {
    case 'start_conversation': {
      const { channel, topic, detail, participants_needed } = args as {
        channel: string; topic: string; detail?: string; participants_needed?: string
      }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      let text = `:large_green_circle: TOPIC: ${topic} | *[${deps.session.sessionName}]*`
      if (detail) text += `\n${detail}`
      if (participants_needed) text += `\nNeeded: ${participants_needed}`
      const result = await deps.webClient.chat.postMessage({ channel: channelId, text })
      const threadTs = result.ts ?? 'unknown'
      return `Conversation started: "${topic}" in #${channel}\nthread_ts: ${threadTs}\nOthers can join with: join_conversation(channel: "${channel}", thread_ts: "${threadTs}")`
    }
    case 'join_conversation': {
      const { channel, thread_ts } = args as { channel: string; thread_ts: string }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: thread_ts })
      await deps.webClient.chat.postMessage({
        channel: channelId, thread_ts,
        text: `:robot_face: *[${deps.session.sessionName}]* joined the conversation`,
      })
      const lines = ['Conversation history:']
      for (const msg of replies.messages ?? []) {
        const parsed = SessionManager.parse(msg.text ?? '')
        const sender = parsed ? parsed.sender : `user:${msg.user ?? 'unknown'}`
        const content = parsed ? parsed.text : (msg.text ?? '')
        lines.push(`  [${sender}]: ${content}`)
      }
      return lines.join('\n')
    }
    case 'reply_in_conversation': {
      const { channel, thread_ts, text } = args as { channel: string; thread_ts: string; text: string }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      await deps.webClient.chat.postMessage({ channel: channelId, thread_ts, text: deps.session.fmt(text) })
      return `Reply sent in thread ${thread_ts}`
    }
    case 'list_conversations': {
      const { channel, include_resolved } = args as { channel: string; include_resolved?: boolean }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      const history = await deps.webClient.conversations.history({ channel: channelId, limit: 50 })
      const convos: Array<{ topic: string; author: string; threadTs: string; replyCount: number; resolved: boolean }> = []
      for (const msg of history.messages ?? []) {
        const match = TOPIC_PATTERN.exec(msg.text ?? '')
        if (!match) continue
        const resolved = match[1] === 'white_check_mark'
        if (!include_resolved && resolved) continue
        convos.push({ topic: match[2]!, author: match[3]!, threadTs: msg.ts ?? '', replyCount: msg.reply_count ?? 0, resolved })
      }
      if (convos.length === 0) return `No ${include_resolved ? '' : 'active '}conversations in #${channel}.`
      const lines = [`Conversations in #${channel}:`]
      for (const c of convos) {
        const status = c.resolved ? ':white_check_mark:' : ':large_green_circle:'
        lines.push(`  ${status} "${c.topic}" by ${c.author} (${c.replyCount} replies) - thread_ts: ${c.threadTs}`)
      }
      return lines.join('\n')
    }
    case 'resolve_conversation': {
      const { channel, thread_ts, summary } = args as { channel: string; thread_ts: string; summary: string }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: thread_ts })
      const parentMsg = (replies.messages ?? [])[0]
      if (parentMsg?.text) {
        const updatedText = parentMsg.text.replace(':large_green_circle:', ':white_check_mark:')
        await deps.webClient.chat.update({ channel: channelId, ts: thread_ts, text: updatedText })
      }
      await deps.webClient.chat.postMessage({
        channel: channelId, thread_ts,
        text: `:white_check_mark: RESOLVED by *[${deps.session.sessionName}]*\n${summary}`,
      })
      return `Conversation ${thread_ts} resolved: ${summary}`
    }
    default:
      throw new Error(`Unknown conversation tool: ${name}`)
  }
}
