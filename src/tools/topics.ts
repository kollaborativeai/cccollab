import type { SessionManager } from '../session.js'
import type { ActiveContext } from '../context.js'
import { normalizeChannelName } from '../context.js'

export interface TopicToolDeps {
  session: SessionManager
  context: ActiveContext
  brokerPort: number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  channel: string
  creator: string
  state: string
  createdAt: string
  messageCount?: number
}

interface BrokerJoinData {
  ok: boolean
  channel?: string
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

const NO_NAME_ERROR = JSON.stringify({
  error: 'No name set. Call introduce first (e.g. "architect", "frontend"). If the user has not specified a name, ASK THE USER what name this session should use before proceeding.',
})

export function createTopicTools() {
  return [
    {
      name: 'list_topics',
      description: 'Return topics as JSON array: [{id, name, channel, state, messageCount, isJoined, isMyActive, creator, createdAt}]. With no channel, scopes across all subscribed channels.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel to scope to. Defaults to all subscribed channels.' },
          include_archived: { type: 'boolean' as const, description: 'Include archived topics (default: false)' },
        },
        required: [],
      },
    },
    {
      name: 'start_topic',
      description: 'Create a topic in a channel (defaults to the active channel). Returns {id, name, channel}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name / title' },
          channel: { type: 'string' as const, description: 'Channel to create the topic in. Defaults to active channel.' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'join_topic',
      description: 'Join a topic by name (fuzzy match) or UUID. Returns {id, name, channel, history}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match) or UUID' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'leave_topic',
      description: 'Leave the active topic (or a named topic). Returns {id, name}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match). Defaults to the active topic.' },
        },
      },
    },
    {
      name: 'set_active_topic',
      description: 'Set the active topic among joined topics. Returns {id, name, channel}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name or UUID of a joined topic.' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'archive_topic',
      description: 'Archive a topic. Returns {id, name}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match). Defaults to the active topic.' },
        },
      },
    },
    {
      name: 'unarchive_topic',
      description: 'Unarchive a previously archived topic. Returns {id, name, channel}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match).' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'send_message_to_topic',
      description: 'Send a message to a topic. Defaults to the active topic. Returns {topicId}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'Message text' },
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match). Defaults to active topic.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'list_sessions',
      description: 'Return visible sessions as JSON array: [{name, objective?, channels, registeredAt}].',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel to scope to. Defaults to all your subscribed channels.' },
        },
      },
    },
    {
      name: 'send_message_to_session',
      description: 'Send a private direct message to another session. Requires shared channel. Returns {to, viaChannel}.',
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

const REQUIRES_NAME = new Set([
  'start_topic', 'join_topic', 'leave_topic', 'set_active_topic', 'archive_topic', 'unarchive_topic',
  'send_message_to_topic', 'list_sessions', 'send_message_to_session',
])

export async function handleTopicTool(
  name: string, args: Record<string, unknown>, deps: TopicToolDeps,
): Promise<string> {
  if (REQUIRES_NAME.has(name) && !deps.session.hasName()) {
    return NO_NAME_ERROR
  }

  switch (name) {
    case 'list_topics': {
      const { channel, include_archived } = args as { channel?: string; include_archived?: boolean }
      return handleListTopics(deps, channel, include_archived)
    }
    case 'start_topic': {
      const { topic, channel } = args as { topic: string; channel?: string }
      return handleStartTopic(deps, topic, channel)
    }
    case 'join_topic': {
      const { topic } = args as { topic: string }
      return handleJoinTopic(deps, topic)
    }
    case 'set_active_topic': {
      const { topic } = args as { topic: string }
      return handleSetActiveTopic(deps, topic)
    }
    case 'send_message_to_topic': {
      const { text, topic } = args as { text: string; topic?: string }
      if (typeof text !== 'string' || text.trim() === '') {
        return JSON.stringify({ error: '`text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)' })
      }
      if (deps.context.hasTopic() && !topic) {
        return handleSendMessage(deps, text, deps.context.getThreadTs())
      }
      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (found) return handleSendMessage(deps, text, found.threadTs)
        const resolved = await resolveTopicIdInSubscribedChannels(deps, topic)
        if ('error' in resolved) return JSON.stringify(resolved)
        return handleSendMessage(deps, text, resolved.id)
      }
      return JSON.stringify({ error: 'No active topic. Use join_topic or start_topic first, or pass a `topic` argument.' })
    }
    case 'leave_topic': {
      const { topic } = args as { topic?: string }
      let threadTs: string
      let topicName: string
      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (!found) return JSON.stringify({ error: `No joined topic matching "${topic}".` })
        threadTs = found.threadTs
        topicName = found.topicName
      } else {
        if (!deps.context.hasTopic()) return JSON.stringify({ error: 'No active topic to leave.' })
        threadTs = deps.context.getThreadTs()
        topicName = deps.context.getTopicName() ?? 'topic'
      }
      await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${threadTs}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: deps.session.displayName }),
      })
      deps.context.leaveTopic(threadTs)
      return JSON.stringify({ id: threadTs, name: topicName })
    }
    case 'archive_topic': {
      const { topic } = args as { topic?: string }
      if (deps.context.hasTopic() && !topic) {
        return handleArchiveTopic(deps, deps.context.getThreadTs())
      }
      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (found) return handleArchiveTopic(deps, found.threadTs)
        return handleArchiveTopicByName(deps, topic)
      }
      return JSON.stringify({ error: 'No active topic. Use join_topic or start_topic first.' })
    }
    case 'unarchive_topic': {
      const { topic } = args as { topic: string }
      return handleUnarchiveTopic(deps, topic)
    }
    case 'list_sessions': {
      const { channel } = args as { channel?: string }
      return handleListSessions(deps, channel)
    }
    case 'send_message_to_session': {
      const { to, text } = args as { to: string; text: string }
      if (typeof text !== 'string' || text.trim() === '') {
        return JSON.stringify({ error: '`text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)' })
      }
      if (typeof to !== 'string' || to.trim() === '') {
        return JSON.stringify({ error: '`to` is required and must be a non-empty string.' })
      }
      const res = await fetch(`${brokerBaseUrl(deps.brokerPort)}/direct-message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: deps.session.displayName, to, text }),
      })
      if (res.status === 403 || res.status === 404) {
        const body = await res.json() as { error?: string }
        return JSON.stringify({ error: body.error ?? `Could not deliver DM to ${to}.` })
      }
      if (!res.ok) {
        throw new Error(`Broker request failed (${res.status}): ${await res.text()}`)
      }
      const body = await res.json() as { viaChannel?: string }
      return JSON.stringify({ to, ...(body.viaChannel ? { viaChannel: body.viaChannel } : {}) })
    }
    default:
      throw new Error(`Unknown topic tool: ${name}`)
  }
}

async function handleListTopics(
  deps: TopicToolDeps, channelArg?: string, includeArchived?: boolean,
): Promise<string> {
  const params = new URLSearchParams()
  if (includeArchived) params.set('include_archived', 'true')

  if (channelArg) {
    const channel = normalizeChannelName(channelArg)
    if (!channel) return JSON.stringify({ error: 'Channel name must be non-empty.' })
    if (!deps.context.isChannelSubscribed(channel)) {
      return JSON.stringify({ error: `Not subscribed to "${channel}". Use join_channel first.` })
    }
    params.set('channel', channel)
  } else {
    params.set('sessionId', deps.session.displayName)
  }

  const url = `${brokerBaseUrl(deps.brokerPort)}/topics?${params.toString()}`
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(url)

  const activeThread = deps.context.hasTopic() ? deps.context.getThreadTs() : null
  const result = data.topics.map((t) => ({
    id: t.id,
    name: t.topic,
    channel: t.channel,
    state: t.state,
    messageCount: t.messageCount ?? 0,
    isJoined: deps.context.isTopicJoined(t.id),
    isMyActive: t.id === activeThread,
    creator: t.creator,
    createdAt: t.createdAt,
  }))
  return JSON.stringify(result)
}

async function handleStartTopic(deps: TopicToolDeps, topic: string, channelArg?: string): Promise<string> {
  let channel = channelArg ? normalizeChannelName(channelArg) : undefined
  if (!channel) channel = deps.context.getActiveChannel()
  if (!channel) {
    return JSON.stringify({ error: 'No active channel. Join a channel first with join_channel, or pass a `channel` argument.' })
  }
  if (!deps.context.isChannelSubscribed(channel)) {
    return JSON.stringify({ error: `Not subscribed to "${channel}". Use join_channel first.` })
  }

  const res = await fetch(`${brokerBaseUrl(deps.brokerPort)}/topics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, creator: deps.session.displayName, channel }),
  })
  if (res.status === 409) {
    const body = await res.json() as { error: string }
    return JSON.stringify({ error: body.error, channel, name: topic })
  }
  if (!res.ok) {
    throw new Error(`Broker request failed (${res.status}): ${await res.text()}`)
  }
  const data = await res.json() as BrokerTopicData
  deps.context.joinTopic(data.id, topic, data.channel ?? channel)
  return JSON.stringify({ id: data.id, name: topic, channel: data.channel ?? channel })
}

async function handleJoinTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  if (UUID_PATTERN.test(topic)) {
    const byId = await fetchTopicById(deps.brokerPort, topic, deps.session.displayName)
    if (!byId) return JSON.stringify({ error: `No topic with id "${topic}" found.` })
    if (!deps.context.isChannelSubscribed(byId.channel)) {
      return JSON.stringify({
        error: `Topic "${byId.topic}" is in channel "${byId.channel}", which you are not subscribed to. Use join_channel first.`,
        channel: byId.channel,
        name: byId.topic,
      })
    }
    return joinTopicByData(deps, byId)
  }

  const params = new URLSearchParams()
  params.set('sessionId', deps.session.displayName)
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics?${params.toString()}`
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(url)
  const { match, ambiguous } = pickMatch(data.topics, topic)

  if (!match) {
    if (ambiguous.length > 1) {
      return JSON.stringify({
        error: `Multiple topics match "${topic}". Be more specific.`,
        matches: ambiguous.map((m) => ({ id: m.id, name: m.topic, channel: m.channel })),
      })
    }
    return JSON.stringify({ error: `No active topic matching "${topic}" found in your subscribed channels.` })
  }

  return joinTopicByData(deps, match)
}

async function handleSetActiveTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  const found = deps.context.findJoinedTopic(topic)
  if (!found) {
    return JSON.stringify({ error: `No joined topic matching "${topic}". Use join_topic first.` })
  }
  deps.context.joinTopic(found.threadTs, found.topicName, found.channel)
  return JSON.stringify({ id: found.threadTs, name: found.topicName, channel: found.channel })
}

async function fetchTopicById(brokerPort: number, id: string, sessionId: string): Promise<BrokerTopicData | null> {
  try {
    const url = `${brokerBaseUrl(brokerPort)}/topics/${id}?sessionId=${encodeURIComponent(sessionId)}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = (await res.json()) as { topic: BrokerTopicData }
    return data.topic
  } catch {
    return null
  }
}

async function joinTopicByData(deps: TopicToolDeps, topic: BrokerTopicData): Promise<string> {
  const joinUrl = `${brokerBaseUrl(deps.brokerPort)}/topics/${topic.id}/join`
  const joinData = await brokerFetch<BrokerJoinData>(joinUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: deps.session.displayName }),
  })

  deps.context.joinTopic(topic.id, topic.topic, topic.channel)

  return JSON.stringify({
    id: topic.id,
    name: topic.topic,
    channel: topic.channel,
    history: joinData.messages,
  })
}

async function handleSendMessage(deps: TopicToolDeps, text: string, topicId: string): Promise<string> {
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics/${topicId}/messages`
  await brokerFetch<{ ok: boolean }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sender: deps.session.displayName }),
  })
  return JSON.stringify({ topicId })
}

async function handleArchiveTopic(deps: TopicToolDeps, topicId: string): Promise<string> {
  const topicName = deps.context.getTopicName() ?? 'topic'
  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${topicId}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivedBy: deps.session.displayName }),
  })
  deps.context.leaveTopic(topicId)
  return JSON.stringify({ id: topicId, name: topicName })
}

async function handleArchiveTopicByName(deps: TopicToolDeps, name: string): Promise<string> {
  const resolved = await resolveTopicIdInSubscribedChannels(deps, name)
  if ('error' in resolved) return JSON.stringify(resolved)
  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${resolved.id}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivedBy: deps.session.displayName }),
  })
  deps.context.leaveTopic(resolved.id)
  return JSON.stringify({ id: resolved.id, name: resolved.topicName })
}

async function handleUnarchiveTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  if (UUID_PATTERN.test(topic)) {
    const byId = await fetchTopicById(deps.brokerPort, topic, deps.session.displayName)
    if (!byId || byId.state !== 'archived') return JSON.stringify({ error: `No archived topic with id "${topic}".` })
    if (!deps.context.isChannelSubscribed(byId.channel)) {
      return JSON.stringify({
        error: `Topic "${byId.topic}" is in "${byId.channel}", which you are not subscribed to. Use join_channel first.`,
        channel: byId.channel,
        name: byId.topic,
      })
    }
    await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${byId.id}/unarchive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    return JSON.stringify({ id: byId.id, name: byId.topic, channel: byId.channel })
  }

  const params = new URLSearchParams()
  params.set('include_archived', 'true')
  params.set('sessionId', deps.session.displayName)
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(
    `${brokerBaseUrl(deps.brokerPort)}/topics?${params.toString()}`,
  )
  const archived = data.topics.filter((t) => t.state === 'archived')
  const { match, ambiguous } = pickMatch(archived, topic)

  if (!match) {
    if (ambiguous.length > 1) {
      return JSON.stringify({
        error: `Multiple archived topics match "${topic}". Be more specific.`,
        matches: ambiguous.map((m) => ({ id: m.id, name: m.topic, channel: m.channel })),
      })
    }
    return JSON.stringify({ error: `No archived topic matching "${topic}" in your subscribed channels.` })
  }

  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${match.id}/unarchive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  return JSON.stringify({ id: match.id, name: match.topic, channel: match.channel })
}

async function handleListSessions(deps: TopicToolDeps, channelArg?: string): Promise<string> {
  const params = new URLSearchParams()
  if (channelArg) {
    const channel = normalizeChannelName(channelArg)
    if (!channel) return JSON.stringify({ error: 'Channel name must be non-empty.' })
    if (!deps.context.isChannelSubscribed(channel)) {
      return JSON.stringify({ error: `Not subscribed to "${channel}". Use join_channel first.` })
    }
    params.set('channel', channel)
  }
  const url = `${brokerBaseUrl(deps.brokerPort)}/sessions${params.toString() ? `?${params.toString()}` : ''}`
  const data = await brokerFetch<{ sessions: Array<{ name: string; objective?: string; registeredAt: string; channels?: string[] }> }>(url)

  const myChannels = new Set(deps.context.getSubscribedChannels().map((c) => c.name))
  const visible = channelArg ? data.sessions : data.sessions.filter((s) => {
    if (!s.channels || s.channels.length === 0) return false
    return s.channels.some((ch) => myChannels.has(ch))
  })

  const result = visible.map((s) => ({
    name: s.name,
    ...(s.objective ? { objective: s.objective } : {}),
    channels: s.channels ?? [],
    registeredAt: s.registeredAt,
  }))
  return JSON.stringify(result)
}

interface ResolvedTopic { id: string; topicName: string }
interface ResolveError { error: string; matches?: Array<{ id: string; name: string; channel: string }> }

async function resolveTopicIdInSubscribedChannels(
  deps: TopicToolDeps, name: string,
): Promise<ResolvedTopic | ResolveError> {
  if (UUID_PATTERN.test(name)) {
    const byId = await fetchTopicById(deps.brokerPort, name, deps.session.displayName)
    if (!byId) return { error: `No topic with id "${name}".` }
    if (!deps.context.isChannelSubscribed(byId.channel)) {
      return { error: `Topic "${byId.topic}" is in "${byId.channel}", which you are not subscribed to.` }
    }
    return { id: byId.id, topicName: byId.topic }
  }
  const params = new URLSearchParams()
  params.set('sessionId', deps.session.displayName)
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics?${params.toString()}`
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(url)
  const { match, ambiguous } = pickMatch(data.topics, name)
  if (!match) {
    if (ambiguous.length > 1) {
      return {
        error: `Multiple topics match "${name}". Be more specific.`,
        matches: ambiguous.map((m) => ({ id: m.id, name: m.topic, channel: m.channel })),
      }
    }
    return { error: `No active topic matching "${name}" in your subscribed channels.` }
  }
  return { id: match.id, topicName: match.topic }
}
