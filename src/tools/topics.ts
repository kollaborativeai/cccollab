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

const TOPIC_PATTERN = /^:(large_green_circle|white_check_mark|red_circle): (.+)$/

export function createTopicTools() {
  return [
    {
      name: 'list_topics',
      description: 'List topics in the active channel. Defaults to last 24 hours only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          include_resolved: { type: 'boolean' as const, description: 'Include resolved topics (default: false)' },
          include_deactivated: { type: 'boolean' as const, description: 'Include deactivated topics (default: false)' },
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
      description: 'Join a topic by name (fuzzy match). Fetches history and sets it as the active topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match)' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'send_message',
      description: 'Send a message to a topic. Defaults to the most recently joined topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'Message text' },
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match). Defaults to most recently joined topic.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'send_broadcast',
      description: 'Send a top-level message to all subscribers of a channel. Not in a topic thread.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'Message text' },
          channel: { type: 'string' as const, description: 'Channel name. Defaults to most recently joined channel.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'resolve_topic',
      description: 'Resolve a topic with a summary. Defaults to most recently joined topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          summary: { type: 'string' as const, description: 'Resolution summary' },
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match). Defaults to most recently joined topic.' },
        },
        required: ['summary'],
      },
    },
    {
      name: 'deactivate_topic',
      description: 'Deactivate a topic. It will be hidden from list_topics by default.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match). Defaults to most recently joined topic.' },
        },
      },
    },
    {
      name: 'activate_topic',
      description: 'Reactivate a previously deactivated topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match).' },
        },
        required: ['topic'],
      },
    },
  ]
}

type TopicState = 'active' | 'deactivated' | 'resolved'

interface TopicInfo {
  topic: string
  threadTs: string
  replyCount: number
  state: TopicState
}

async function fetchTopics(channelId: string, webClient: WebClient): Promise<TopicInfo[]> {
  const history = await webClient.conversations.history({ channel: channelId, limit: 50 })
  const topics: TopicInfo[] = []
  for (const msg of history.messages ?? []) {
    const text = msg.text ?? ''
    const match = TOPIC_PATTERN.exec(text)
    if (!match) continue
    const emoji = match[1]!
    const state: TopicState = emoji === 'white_check_mark' ? 'resolved' : emoji === 'red_circle' ? 'deactivated' : 'active'
    const topic = match[2]!
    topics.push({ topic, threadTs: msg.ts ?? '', replyCount: msg.reply_count ?? 0, state })
  }
  return topics
}

export async function handleTopicTool(
  name: string, args: Record<string, unknown>, deps: TopicToolDeps
): Promise<string> {
  switch (name) {
    case 'list_topics': {
      const { include_resolved, include_deactivated, hours = 24 } = args as {
        include_resolved?: boolean; include_deactivated?: boolean; hours?: number
      }
      const channelId = deps.context.getChannelId()
      const channelName = deps.context.getChannelName()
      const cutoffTs = (Date.now() / 1000 - hours * 3600).toString()
      const topics = await fetchTopics(channelId, deps.webClient)
      const filtered = topics.filter((t) => {
        if (t.threadTs < cutoffTs) return false
        if (!include_resolved && t.state === 'resolved') return false
        if (!include_deactivated && t.state === 'deactivated') return false
        return true
      })
      if (filtered.length === 0) {
        return `No active topics in #${channelName} in the last ${hours}h.`
      }
      const statusEmoji: Record<TopicState, string> = {
        active: ':large_green_circle:',
        deactivated: ':red_circle:',
        resolved: ':white_check_mark:',
      }
      const lines = [`Topics in #${channelName} (last ${hours}h):`]
      for (const t of filtered) {
        const joined = deps.context.isTopicJoined(t.threadTs) ? ' <-- joined' : ''
        const active = t.threadTs === (deps.context.hasTopic() ? deps.context.getThreadTs() : null) ? ' (active)' : ''
        lines.push(`  ${statusEmoji[t.state]} "${t.topic}" (${t.replyCount} replies)${joined}${active}`)
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
      return `Topic started: "${topic}" in #${channelName}. This is now your active topic.`
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
            const emoji: Record<TopicState, string> = { active: ':large_green_circle:', deactivated: ':red_circle:', resolved: ':white_check_mark:' }
            lines.push(`  ${emoji[m.state]} "${m.topic}"`)
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
      const { text, topic } = args as { text: string; topic?: string }
      const channelId = deps.context.getChannelId()

      let threadTs: string
      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (!found) {
          const joined = deps.context.getJoinedTopics()
          if (joined.length === 0) return 'No joined topics. Use join_topic first.'
          const lines = [`No joined topic matching "${topic}". Your joined topics:`]
          for (const t of joined) lines.push(`  - "${t.topicName}"`)
          return lines.join('\n')
        }
        threadTs = found.threadTs
      } else {
        threadTs = deps.context.getThreadTs()
      }

      await deps.postClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: deps.session.fmt(text) })
      return `Message sent.`
    }
    case 'send_broadcast': {
      const { text, channel } = args as { text: string; channel?: string }
      let channelId: string
      let channelName: string
      if (channel) {
        channelId = await deps.subscriptionManager.resolveChannelId(channel)
        channelName = channel
      } else {
        channelId = deps.context.getChannelId()
        channelName = deps.context.getChannelName()
      }
      await deps.postClient.chat.postMessage({ channel: channelId, text: deps.session.fmt(text) })
      return `Broadcast sent in #${channelName}.`
    }
    case 'resolve_topic': {
      const { summary, topic } = args as { summary: string; topic?: string }
      const channelId = deps.context.getChannelId()

      let threadTs: string
      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (!found) return `No joined topic matching "${topic}".`
        threadTs = found.threadTs
      } else {
        threadTs = deps.context.getThreadTs()
      }

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
    case 'deactivate_topic': {
      const { topic } = args as { topic?: string }
      const channelId = deps.context.getChannelId()

      let threadTs: string
      let topicName: string
      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (!found) return `No joined topic matching "${topic}".`
        threadTs = found.threadTs
        topicName = found.topicName
      } else {
        threadTs = deps.context.getThreadTs()
        topicName = deps.context.getTopicName() ?? 'topic'
      }

      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: threadTs })
      const parentMsg = (replies.messages ?? [])[0]
      if (parentMsg?.text) {
        const updatedText = parentMsg.text.replace(':large_green_circle:', ':red_circle:')
        await deps.postClient.chat.update({ channel: channelId, ts: threadTs, text: updatedText })
      }
      deps.context.leaveTopic(threadTs)
      return `Topic "${topicName}" deactivated.`
    }
    case 'activate_topic': {
      const { topic } = args as { topic: string }
      const channelId = deps.context.getChannelId()

      // Search all topics including deactivated
      const topics = await fetchTopics(channelId, deps.webClient)
      const query = topic.toLowerCase()
      const matches = topics.filter((t) => t.state === 'deactivated' && t.topic.toLowerCase().includes(query))

      if (matches.length === 0) return `No deactivated topic matching "${topic}".`
      if (matches.length > 1) {
        const lines = [`Multiple deactivated topics match "${topic}". Be more specific:`]
        for (const m of matches) lines.push(`  :red_circle: "${m.topic}"`)
        return lines.join('\n')
      }

      const match = matches[0]!
      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: match.threadTs })
      const parentMsg = (replies.messages ?? [])[0]
      if (parentMsg?.text) {
        const updatedText = parentMsg.text.replace(':red_circle:', ':large_green_circle:')
        await deps.postClient.chat.update({ channel: channelId, ts: match.threadTs, text: updatedText })
      }
      return `Topic "${match.topic}" reactivated.`
    }
    default:
      throw new Error(`Unknown topic tool: ${name}`)
  }
}
