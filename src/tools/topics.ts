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
  brokerPort: number
}

const TOPIC_PATTERN = /^:(large_green_circle|white_check_mark|red_circle): (.+)$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isLocal(channel: string | undefined, context: ActiveContext): boolean {
  return channel === 'local' || (!channel && !context.hasChannel())
}

/** Pick the best match from a list of candidates by name. Exact match wins; else unique substring. */
function pickMatch<T extends { topic: string }>(candidates: T[], query: string): { match: T | null; ambiguous: T[] } {
  const q = query.toLowerCase()
  const exact = candidates.filter((t) => t.topic.toLowerCase() === q)
  if (exact.length === 1) return { match: exact[0]!, ambiguous: [] }
  if (exact.length > 1) return { match: null, ambiguous: exact }
  const fuzzy = candidates.filter((t) => t.topic.toLowerCase().includes(q))
  if (fuzzy.length === 1) return { match: fuzzy[0]!, ambiguous: [] }
  if (fuzzy.length > 1) return { match: null, ambiguous: fuzzy }
  return { match: null, ambiguous: [] }
}

function brokerBaseUrl(port: number): string {
  return `http://localhost:${port}`
}

interface BrokerTopicData {
  id: string
  topic: string
  creator: string
  state: string
  createdAt: string
  messageCount?: number
}

interface BrokerJoinData {
  ok: boolean
  messages: Array<{ sender: string; text: string; ts: string }>
}

async function brokerFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options)
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Broker request failed (${res.status}): ${body}`)
  }
  return res.json() as Promise<T>
}

export function createTopicTools() {
  return [
    {
      name: 'list_topics',
      description: 'List topics in the active channel or in local. Defaults to last 24 hours only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name. Use "local" for local topics, or omit to use the active channel (falls back to local if no channel is active).' },
          include_resolved: { type: 'boolean' as const, description: 'Include resolved topics (default: false)' },
          include_deactivated: { type: 'boolean' as const, description: 'Include deactivated topics (default: false)' },
          hours: { type: 'number' as const, description: 'How many hours back to look (default: 24)' },
        },
        required: [],
      },
    },
    {
      name: 'start_topic',
      description: 'Create a new topic in the active channel or in local and set it as the active topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name / title' },
          channel: { type: 'string' as const, description: 'Channel name. Use "local" for local topics, or omit to use the active channel (falls back to local if no channel is active).' },
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
          channel: { type: 'string' as const, description: 'Channel name. Use "local" for local topics, or omit to use the active channel (falls back to local if no channel is active).' },
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
      description: 'Send a top-level message to all subscribers. Not in a topic thread.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'Message text' },
          channel: { type: 'string' as const, description: 'Channel name. Use "local" for local broadcast, or omit to use the active channel (falls back to local if no channel is active).' },
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
    {
      name: 'ping_availability',
      description: 'Broadcast a local ping asking which sessions are currently available. Responses arrive as channel events automatically - no action required from the sender.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'send_direct',
      description: 'Send a private direct message to another session by name. Local only - no Slack.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: { type: 'string' as const, description: 'Recipient session name (must match their introduced name exactly)' },
          text: { type: 'string' as const, description: 'Message text' },
        },
        required: ['to', 'text'],
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

const REQUIRES_NAME = new Set(['start_topic', 'join_topic', 'send_message', 'send_broadcast', 'resolve_topic', 'deactivate_topic', 'activate_topic', 'ping_availability', 'send_direct'])

export async function handleTopicTool(
  name: string, args: Record<string, unknown>, deps: TopicToolDeps
): Promise<string> {
  if (REQUIRES_NAME.has(name) && !deps.session.hasName()) {
    return 'This session has no name set. Call `introduce` first with a name (e.g., "architect", "frontend"). If the user has not specified a name, ASK THE USER what name this session should use before proceeding.'
  }

  switch (name) {
    case 'list_topics': {
      const { channel, include_resolved, include_deactivated, hours = 24 } = args as {
        channel?: string; include_resolved?: boolean; include_deactivated?: boolean; hours?: number
      }

      if (isLocal(channel, deps.context)) {
        return handleLocalListTopics(deps, include_resolved, include_deactivated)
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
      const { topic, channel, detail, participants_needed } = args as {
        topic: string; channel?: string; detail?: string; participants_needed?: string
      }

      if (isLocal(channel, deps.context)) {
        return handleLocalStartTopic(deps, topic)
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
      deps.context.joinTopic(threadTs, topic, 'slack', channelId)
      return `Topic started: "${topic}" in #${channelName}. This is now your active topic.`
    }
    case 'join_topic': {
      const { topic, channel } = args as { topic: string; channel?: string }

      if (isLocal(channel, deps.context)) {
        return handleLocalJoinTopic(deps, topic)
      }

      const channelId = deps.context.getChannelId()
      const channelName = deps.context.getChannelName()

      let threadTs: string
      let topicName: string

      if (/^\d+\.\d+$/.test(topic)) {
        // Exact thread_ts
        threadTs = topic
        topicName = topic
      } else {
        const topics = await fetchTopics(channelId, deps.webClient)
        const activeOnly = topics.filter((t) => t.state === 'active')
        const { match, ambiguous } = pickMatch(activeOnly, topic)
        if (!match) {
          if (ambiguous.length > 1) {
            const lines = [`Multiple topics match "${topic}" in #${channelName}. Be more specific:`]
            for (const m of ambiguous) lines.push(`  :large_green_circle: "${m.topic}"`)
            return lines.join('\n')
          }
          return `No active topic matching "${topic}" found in #${channelName}.`
        }
        threadTs = match.threadTs
        topicName = match.topic
      }

      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: threadTs })
      deps.context.joinTopic(threadTs, topicName, 'slack', channelId)

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

      // Active local topic with no topic arg
      if (deps.context.hasTopic() && deps.context.getTopicSource() === 'local' && !topic) {
        return handleLocalSendMessage(deps, text, deps.context.getThreadTs())
      }

      if (topic) {
        // Check joined topics first (local or slack)
        const found = deps.context.findJoinedTopic(topic)
        if (found && found.source === 'local') {
          return handleLocalSendMessage(deps, text, found.threadTs)
        }
        if (!found) {
          // Not joined - try resolving as a local topic and post without joining
          if (!deps.context.hasChannel()) {
            const resolved = await resolveLocalTopicId(deps.brokerPort, topic)
            if (!resolved.error) {
              return handleLocalSendMessage(deps, text, resolved.id!)
            }
          } else {
            // Try local first, then Slack
            const localResolved = await resolveLocalTopicId(deps.brokerPort, topic)
            if (!localResolved.error) {
              return handleLocalSendMessage(deps, text, localResolved.id!)
            }
            // Fall through to Slack unjoined send below
            const channelId = deps.context.getChannelId()
            const channelName = deps.context.getChannelName()
            const topics = await fetchTopics(channelId, deps.webClient)
            const activeOnly = topics.filter((t) => t.state === 'active')
            const { match, ambiguous } = pickMatch(activeOnly, topic)
            if (!match) {
              if (ambiguous.length > 1) {
                const lines = [`Multiple topics match "${topic}". Be more specific:`]
                for (const m of ambiguous) lines.push(`  "${m.topic}"`)
                return lines.join('\n')
              }
              return `No topic matching "${topic}" found in #${channelName} or local.`
            }
            await deps.postClient.chat.postMessage({ channel: channelId, thread_ts: match.threadTs, text: deps.session.fmt(text) })
            return 'Message sent.'
          }
        }
      }

      const channelId = deps.context.getChannelId()
      const threadTs = topic
        ? (deps.context.findJoinedTopic(topic)?.threadTs ?? deps.context.getThreadTs())
        : deps.context.getThreadTs()

      await deps.postClient.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: deps.session.fmt(text) })
      return 'Message sent.'
    }
    case 'send_broadcast': {
      const { text, channel } = args as { text: string; channel?: string }

      if (isLocal(channel, deps.context)) {
        return handleLocalBroadcast(deps, text)
      }

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

      // Check if active topic is local
      if (deps.context.hasTopic() && deps.context.getTopicSource() === 'local' && !topic) {
        return handleLocalResolveTopic(deps, summary, deps.context.getThreadTs())
      }

      // If a topic name is given, check if it resolves to a local topic
      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (found && found.source === 'local') {
          return handleLocalResolveTopic(deps, summary, found.threadTs)
        }
      }

      // If no Slack channel, fall back to local lookup via broker
      if (!deps.context.hasChannel()) {
        if (!topic) return 'No active topic. Use join_topic or start_topic first.'
        return handleLocalResolveTopicByName(deps, summary, topic)
      }

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

      // Check if active topic is local
      if (deps.context.hasTopic() && deps.context.getTopicSource() === 'local' && !topic) {
        return handleLocalDeactivateTopic(deps, deps.context.getThreadTs())
      }

      // If a topic name is given, check if it resolves to a local topic
      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (found && found.source === 'local') {
          return handleLocalDeactivateTopic(deps, found.threadTs)
        }
      }

      // If no Slack channel, fall back to local lookup via broker
      if (!deps.context.hasChannel()) {
        if (!topic) return 'No active topic. Use join_topic or start_topic first.'
        return handleLocalDeactivateTopicByName(deps, topic)
      }

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

      // For local topics, check if we need to activate via broker
      // Try Slack first if we have a channel, otherwise go local
      if (!deps.context.hasChannel()) {
        return handleLocalActivateTopic(deps, topic)
      }

      const channelId = deps.context.getChannelId()

      // Search deactivated topics only
      const topics = await fetchTopics(channelId, deps.webClient)
      const deactivated = topics.filter((t) => t.state === 'deactivated')
      const { match, ambiguous } = pickMatch(deactivated, topic)

      if (!match) {
        if (ambiguous.length > 1) {
          const lines = [`Multiple deactivated topics match "${topic}". Be more specific:`]
          for (const m of ambiguous) lines.push(`  :red_circle: "${m.topic}"`)
          return lines.join('\n')
        }
        // Fall back to local
        return handleLocalActivateTopic(deps, topic)
      }

      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: match.threadTs })
      const parentMsg = (replies.messages ?? [])[0]
      if (parentMsg?.text) {
        const updatedText = parentMsg.text.replace(':red_circle:', ':large_green_circle:')
        await deps.postClient.chat.update({ channel: channelId, ts: match.threadTs, text: updatedText })
      }
      return `Topic "${match.topic}" reactivated.`
    }
    case 'ping_availability': {
      await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/local-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ping_availability', from: deps.session.displayName }),
      })
      return 'Availability ping sent. Responses will arrive as channel events.'
    }
    case 'send_direct': {
      const { to, text } = args as { to: string; text: string }
      await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/local-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'direct_message', from: deps.session.displayName, to, text }),
      })
      return `Direct message sent to ${to}.`
    }
    default:
      throw new Error(`Unknown topic tool: ${name}`)
  }
}

// --- Local topic handlers ---

async function handleLocalListTopics(
  deps: TopicToolDeps, includeResolved?: boolean, includeDeactivated?: boolean
): Promise<string> {
  const params = new URLSearchParams()
  if (includeResolved) params.set('include_resolved', 'true')
  if (includeDeactivated) params.set('include_deactivated', 'true')
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics?${params.toString()}`
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(url)
  if (data.topics.length === 0) {
    return 'No active local topics.'
  }
  const statusEmoji: Record<string, string> = {
    active: ':large_green_circle:',
    deactivated: ':red_circle:',
    resolved: ':white_check_mark:',
  }
  const lines = ['Local topics:']
  for (const t of data.topics) {
    const joined = deps.context.isTopicJoined(t.id) ? ' <-- joined' : ''
    const active = t.id === (deps.context.hasTopic() ? deps.context.getThreadTs() : null) ? ' (active)' : ''
    lines.push(`  ${statusEmoji[t.state] ?? ''} "${t.topic}" (${t.messageCount ?? 0} messages)${joined}${active}`)
  }
  return lines.join('\n')
}

async function handleLocalStartTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics`
  const data = await brokerFetch<BrokerTopicData>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, creator: deps.session.displayName }),
  })
  deps.context.joinTopic(data.id, topic, 'local')
  return `Local topic started: "${topic}". This is now your active topic.`
}

async function handleLocalJoinTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  // Direct UUID lookup
  if (UUID_PATTERN.test(topic)) {
    const byId = await fetchLocalTopicById(deps.brokerPort, topic)
    if (!byId) return `No local topic with id "${topic}" found.`
    return joinLocalTopic(deps, byId)
  }

  const url = `${brokerBaseUrl(deps.brokerPort)}/topics`
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(url)
  const { match, ambiguous } = pickMatch(data.topics, topic)

  if (!match) {
    if (ambiguous.length > 1) {
      const lines = [`Multiple local topics match "${topic}". Be more specific:`]
      for (const m of ambiguous) lines.push(`  "${m.topic}"`)
      return lines.join('\n')
    }
    return `No active local topic matching "${topic}" found.`
  }

  return joinLocalTopic(deps, match)
}

async function fetchLocalTopicById(brokerPort: number, id: string): Promise<BrokerTopicData | null> {
  try {
    const url = `${brokerBaseUrl(brokerPort)}/topics/${id}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = (await res.json()) as { topic: BrokerTopicData }
    return data.topic
  } catch {
    return null
  }
}

async function joinLocalTopic(deps: TopicToolDeps, topic: BrokerTopicData): Promise<string> {
  const joinUrl = `${brokerBaseUrl(deps.brokerPort)}/topics/${topic.id}/join`
  const joinData = await brokerFetch<BrokerJoinData>(joinUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: deps.session.sessionName }),
  })

  deps.context.joinTopic(topic.id, topic.topic, 'local')

  const lines = [`Joined local topic "${topic.topic}". This is now your active topic.`, '', 'Topic history:']
  for (const msg of joinData.messages) {
    lines.push(`  [${msg.sender}]: ${msg.text}`)
  }
  return lines.join('\n')
}

async function handleLocalSendMessage(deps: TopicToolDeps, text: string, topicId: string): Promise<string> {
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics/${topicId}/messages`
  await brokerFetch<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sender: deps.session.displayName }),
  })
  return 'Message sent.'
}

async function handleLocalBroadcast(deps: TopicToolDeps, text: string): Promise<string> {
  const url = `${brokerBaseUrl(deps.brokerPort)}/broadcast`
  await brokerFetch<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sender: deps.session.displayName }),
  })
  return 'Broadcast sent in local.'
}

async function handleLocalResolveTopic(deps: TopicToolDeps, summary: string, topicId: string): Promise<string> {
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics/${topicId}/resolve`
  await brokerFetch<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary, resolver: deps.session.displayName }),
  })
  deps.context.clearTopic()
  return `Topic resolved: ${summary}`
}

async function handleLocalResolveTopicByName(deps: TopicToolDeps, summary: string, name: string): Promise<string> {
  const id = await resolveLocalTopicId(deps.brokerPort, name)
  if (id.error) return id.error
  return handleLocalResolveTopic(deps, summary, id.id!)
}

async function handleLocalDeactivateTopicByName(deps: TopicToolDeps, name: string): Promise<string> {
  const id = await resolveLocalTopicId(deps.brokerPort, name)
  if (id.error) return id.error
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics/${id.id}/deactivate`
  await brokerFetch<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  deps.context.leaveTopic(id.id!)
  return `Topic "${id.topicName}" deactivated.`
}

async function resolveLocalTopicId(
  brokerPort: number, name: string,
): Promise<{ id?: string; topicName?: string; error?: string }> {
  if (UUID_PATTERN.test(name)) {
    const byId = await fetchLocalTopicById(brokerPort, name)
    if (!byId) return { error: `No local topic with id "${name}".` }
    return { id: byId.id, topicName: byId.topic }
  }
  const url = `${brokerBaseUrl(brokerPort)}/topics`
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(url)
  const { match, ambiguous } = pickMatch(data.topics, name)
  if (!match) {
    if (ambiguous.length > 1) {
      const lines = [`Multiple local topics match "${name}". Be more specific:`]
      for (const m of ambiguous) lines.push(`  "${m.topic}"`)
      return { error: lines.join('\n') }
    }
    return { error: `No active local topic matching "${name}".` }
  }
  return { id: match.id, topicName: match.topic }
}

async function handleLocalDeactivateTopic(deps: TopicToolDeps, topicId: string): Promise<string> {
  const topicName = deps.context.getTopicName() ?? 'topic'
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics/${topicId}/deactivate`
  await brokerFetch<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  deps.context.leaveTopic(topicId)
  return `Topic "${topicName}" deactivated.`
}

async function handleLocalActivateTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  // Direct UUID lookup
  if (UUID_PATTERN.test(topic)) {
    const byId = await fetchLocalTopicById(deps.brokerPort, topic)
    if (!byId || byId.state !== 'deactivated') {
      return `No deactivated local topic with id "${topic}".`
    }
    await activateLocalTopic(deps, byId.id)
    return `Local topic "${byId.topic}" reactivated.`
  }

  const url = `${brokerBaseUrl(deps.brokerPort)}/topics?include_deactivated=true`
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(url)
  const deactivated = data.topics.filter((t) => t.state === 'deactivated')
  const { match, ambiguous } = pickMatch(deactivated, topic)

  if (!match) {
    if (ambiguous.length > 1) {
      const lines = [`Multiple deactivated local topics match "${topic}". Be more specific:`]
      for (const m of ambiguous) lines.push(`  "${m.topic}"`)
      return lines.join('\n')
    }
    return `No deactivated local topic matching "${topic}".`
  }

  await activateLocalTopic(deps, match.id)
  return `Local topic "${match.topic}" reactivated.`
}

async function activateLocalTopic(deps: TopicToolDeps, id: string): Promise<void> {
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics/${id}/activate`
  await brokerFetch<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}
