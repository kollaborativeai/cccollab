import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'
import type { SubscriptionManager } from '../subscriptions.js'
import type { ActiveContext } from '../context.js'
import { SessionManager as SessionManagerClass } from '../session.js'

export interface TopicToolDeps {
  session: SessionManager
  webClient: WebClient
  postClient: WebClient
  subscriptionManager: SubscriptionManager
  context: ActiveContext
}

const TOPIC_PATTERN = /^:(large_green_circle|white_check_mark): (.+)$/

export function createTopicTools() {
  return [
    {
      name: 'list_topics',
      description: 'List topics in the active channel. Defaults to last 24 hours only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          include_resolved: { type: 'boolean' as const, description: 'Include resolved topics (default: false)' },
          hours: { type: 'number' as const, description: 'How many hours back to look (default: 24)' },
        },
        required: [],
      },
    },
    {
      name: 'start_topic',
      description: 'Create a new topic in the active channel and set it as the active topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name / title' },
          detail: { type: 'string' as const, description: 'Additional detail' },
          participants_needed: { type: 'string' as const, description: 'Roles or people needed' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'join_topic',
      description: 'Join a topic by fuzzy name match or exact thread_ts. Fetches history, announces, and sets it as the active topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match) or exact thread_ts' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'send_message',
      description: 'Send a message to the active topic (or active channel if no topic is set).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'Message text' },
        },
        required: ['text'],
      },
    },
    {
      name: 'resolve_topic',
      description: 'Resolve the active topic with a summary. Updates the parent message emoji and clears the active topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          summary: { type: 'string' as const, description: 'Resolution summary' },
        },
        required: ['summary'],
      },
    },
  ]
}

interface TopicInfo {
  topic: string
  threadTs: string
  replyCount: number
  resolved: boolean
}

async function fetchTopics(channelId: string, webClient: WebClient): Promise<TopicInfo[]> {
  const history = await webClient.conversations.history({ channel: channelId, limit: 50 })
  const topics: TopicInfo[] = []
  for (const msg of history.messages ?? []) {
    const text = msg.text ?? ''
    const match = TOPIC_PATTERN.exec(text)
    if (!match) continue
    const resolved = match[1] === 'white_check_mark'
    const topic = match[2]!
    topics.push({ topic, threadTs: msg.ts ?? '', replyCount: msg.reply_count ?? 0, resolved })
  }
  return topics
}

export async function handleTopicTool(
  name: string, args: Record<string, unknown>, deps: TopicToolDeps
): Promise<string> {
  switch (name) {
    case 'list_topics': {
      const { include_resolved, hours = 24 } = args as { include_resolved?: boolean; hours?: number }
      const channelId = deps.context.getChannelId()
      const channelName = deps.context.getChannelName()
      const cutoffTs = (Date.now() / 1000 - hours * 3600).toString()
      const topics = await fetchTopics(channelId, deps.webClient)
      const filtered = topics.filter((t) => {
        if (t.threadTs < cutoffTs) return false
        if (!include_resolved && t.resolved) return false
        return true
      })
      if (filtered.length === 0) {
        return `No ${include_resolved ? '' : 'active '}topics in #${channelName} in the last ${hours}h.`
      }
      const lines = [`Topics in #${channelName} (last ${hours}h):`]
      for (const t of filtered) {
        const status = t.resolved ? ':white_check_mark:' : ':large_green_circle:'
        lines.push(`  ${status} "${t.topic}" (${t.replyCount} replies) - thread_ts: ${t.threadTs}`)
      }
      return lines.join('\n')
    }
    case 'start_topic': {
      const { topic, detail, participants_needed } = args as {
        topic: string; detail?: string; participants_needed?: string
      }
      const channelId = deps.context.getChannelId()
      const channelName = deps.context.getChannelName()
      const headerText = `:large_green_circle: ${topic}`
      const result = await deps.postClient.chat.postMessage({ channel: channelId, text: headerText })
      // Post detail as first thread reply if provided
      if (detail || participants_needed) {
        let detailText = ''
        if (detail) detailText += detail
        if (participants_needed) detailText += `${detailText ? '\n' : ''}Needed: ${participants_needed}`
        await deps.postClient.chat.postMessage({
          channel: channelId,
          thread_ts: result.ts!,
          text: deps.session.fmt(detailText),
        })
      }
      const threadTs = result.ts ?? 'unknown'
      deps.context.joinTopic(threadTs, topic)
      return `Topic started: "${topic}" in #${channelName}\nthread_ts: ${threadTs}\nThis is now your active topic.`
    }
    case 'join_topic': {
      const { topic } = args as { topic: string }
      const channelId = deps.context.getChannelId()
      const channelName = deps.context.getChannelName()
      const query = topic.toLowerCase()

      let threadTs: string
      let topicName: string

      if (/^\d+\.\d+$/.test(query)) {
        // Exact thread_ts
        threadTs = topic
        topicName = topic
      } else {
        const topics = await fetchTopics(channelId, deps.webClient)
        const matches = topics.filter((t) => t.topic.toLowerCase().includes(query))
        if (matches.length === 0) {
          return `No topic matching "${topic}" found in #${channelName}.`
        }
        if (matches.length > 1) {
          const lines = [`Multiple topics match "${topic}" in #${channelName}. Be more specific:`]
          for (const m of matches) {
            const status = m.resolved ? ':white_check_mark:' : ':large_green_circle:'
            lines.push(`  ${status} "${m.topic}" - thread_ts: ${m.threadTs}`)
          }
          return lines.join('\n')
        }
        const match = matches[0]!
        threadTs = match.threadTs
        topicName = match.topic
      }

      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: threadTs })
      deps.context.joinTopic(threadTs, topicName)

      const lines = [`Joined topic "${topicName}" in #${channelName}. This is now your active topic.`, '', 'Topic history:']
      for (const msg of replies.messages ?? []) {
        const parsed = SessionManagerClass.parse(msg.text ?? '')
        const sender = parsed ? parsed.sender : `user:${msg.user ?? 'unknown'}`
        const content = parsed ? parsed.text : (msg.text ?? '')
        lines.push(`  [${sender}]: ${content}`)
      }
      return lines.join('\n')
    }
    case 'send_message': {
      const { text } = args as { text: string }
      const channelId = deps.context.getChannelId()
      const channelName = deps.context.getChannelName()
      if (deps.context.hasTopic()) {
        const threadTs = deps.context.getThreadTs()
        await deps.postClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: deps.session.fmt(text) })
        return `Message sent in topic thread.`
      } else {
        await deps.postClient.chat.postMessage({ channel: channelId, text: deps.session.fmt(text) })
        return `Message sent in #${channelName}.`
      }
    }
    case 'resolve_topic': {
      const { summary } = args as { summary: string }
      const channelId = deps.context.getChannelId()
      const threadTs = deps.context.getThreadTs()
      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: threadTs })
      const parentMsg = (replies.messages ?? [])[0]
      if (parentMsg?.text) {
        const updatedText = parentMsg.text.replace(':large_green_circle:', ':white_check_mark:')
        await deps.postClient.chat.update({ channel: channelId, ts: threadTs, text: updatedText })
      }
      await deps.postClient.chat.postMessage({
        channel: channelId, thread_ts: threadTs,
        text: `:white_check_mark: RESOLVED by *[${deps.session.displayName}]*\n${summary}`,
      })
      deps.context.clearTopic()
      return `Topic resolved: ${summary}`
    }
    default:
      throw new Error(`Unknown topic tool: ${name}`)
  }
}
