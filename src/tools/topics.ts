import type { SessionManager } from '../session.js'
import type { ActiveContext } from '../context.js'

export interface TopicToolDeps {
  session: SessionManager
  context: ActiveContext
  brokerPort: number
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
      description: 'List local topics. Defaults to active topics only.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          include_archived: { type: 'boolean' as const, description: 'Include archived topics (default: false)' },
        },
        required: [],
      },
    },
    {
      name: 'start_topic',
      description: 'Create a new local topic and set it as the active topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name / title' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'join_topic',
      description: 'Join a local topic by name (fuzzy match) or UUID. Fetches history and sets it as the active topic.',
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
      description: 'Leave the active topic (or a named topic). Clears active topic and stops receiving its messages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match). Defaults to the active topic.' },
        },
      },
    },
    {
      name: 'archive_topic',
      description: 'Archive a topic. Archived topics are hidden from list_topics by default and can be restored with unarchive_topic.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match). Defaults to the active topic.' },
        },
      },
    },
    {
      name: 'unarchive_topic',
      description: 'Unarchive a previously archived topic, making it active again.',
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
        },
        required: ['text'],
      },
    },
    {
      name: 'list_sessions',
      description: 'List all sessions currently registered on this broker. Only shows sessions that have introduced themselves.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'send_message_to_session',
      description: 'Send a private direct message to another session by name.',
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

const REQUIRES_NAME = new Set(['start_topic', 'join_topic', 'leave_topic', 'archive_topic', 'unarchive_topic', 'send_message_to_topic', 'send_broadcast', 'list_sessions', 'send_message_to_session'])

export async function handleTopicTool(
  name: string, args: Record<string, unknown>, deps: TopicToolDeps
): Promise<string> {
  if (REQUIRES_NAME.has(name) && !deps.session.hasName()) {
    return 'This session has no name set. Call `introduce` first with a name (e.g., "architect", "frontend"). If the user has not specified a name, ASK THE USER what name this session should use before proceeding.'
  }

  switch (name) {
    case 'list_topics': {
      const { include_archived } = args as { include_archived?: boolean }
      return handleLocalListTopics(deps, include_archived)
    }
    case 'start_topic': {
      const { topic } = args as { topic: string }
      return handleLocalStartTopic(deps, topic)
    }
    case 'join_topic': {
      const { topic } = args as { topic: string }
      return handleLocalJoinTopic(deps, topic)
    }
    case 'send_message_to_topic': {
      const { text, topic } = args as { text: string; topic?: string }

      if (typeof text !== 'string' || text.trim() === '') {
        return 'Error: `text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)'
      }

      // Active topic with no topic arg
      if (deps.context.hasTopic() && !topic) {
        return handleLocalSendMessage(deps, text, deps.context.getThreadTs())
      }

      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (found) {
          return handleLocalSendMessage(deps, text, found.threadTs)
        }
        // Not joined - resolve by name/UUID and post without joining
        const resolved = await resolveLocalTopicId(deps.brokerPort, topic)
        if (resolved.error) return resolved.error
        return handleLocalSendMessage(deps, text, resolved.id!)
      }

      return 'No active topic. Use join_topic or start_topic first, or pass a `topic` argument.'
    }
    case 'send_broadcast': {
      const { text } = args as { text: string }

      if (typeof text !== 'string' || text.trim() === '') {
        return 'Error: `text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)'
      }

      return handleLocalBroadcast(deps, text)
    }
    case 'leave_topic': {
      const { topic } = args as { topic?: string }
      let threadTs: string
      let topicName: string

      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (!found) return `No joined topic matching "${topic}".`
        threadTs = found.threadTs
        topicName = found.topicName
      } else {
        if (!deps.context.hasTopic()) return 'No active topic to leave.'
        threadTs = deps.context.getThreadTs()
        topicName = deps.context.getTopicName() ?? 'topic'
      }

      await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${threadTs}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: deps.session.sessionName }),
      })
      deps.context.leaveTopic(threadTs)
      return `Left topic "${topicName}".`
    }
    case 'archive_topic': {
      const { topic } = args as { topic?: string }

      if (deps.context.hasTopic() && !topic) {
        return handleLocalArchiveTopic(deps, deps.context.getThreadTs())
      }

      if (topic) {
        const found = deps.context.findJoinedTopic(topic)
        if (found) {
          return handleLocalArchiveTopic(deps, found.threadTs)
        }
        return handleLocalArchiveTopicByName(deps, topic)
      }

      return 'No active topic. Use join_topic or start_topic first.'
    }
    case 'unarchive_topic': {
      const { topic } = args as { topic: string }
      return handleLocalUnarchiveTopic(deps, topic)
    }
    case 'list_sessions': {
      const data = await brokerFetch<{ sessions: Array<{ name: string; objective?: string; registeredAt: string }> }>(
        `${brokerBaseUrl(deps.brokerPort)}/sessions`
      )
      if (data.sessions.length === 0) return 'No sessions currently registered.'
      const lines = ['Active sessions:']
      for (const s of data.sessions) {
        const obj = s.objective ? ` - ${s.objective}` : ''
        lines.push(`  ${s.name}${obj}`)
      }
      return lines.join('\n')
    }
    case 'send_message_to_session': {
      const { to, text } = args as { to: string; text: string }
      if (typeof text !== 'string' || text.trim() === '') {
        return 'Error: `text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)'
      }
      if (typeof to !== 'string' || to.trim() === '') {
        return 'Error: `to` is required and must be a non-empty string.'
      }
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
  deps: TopicToolDeps, includeArchived?: boolean
): Promise<string> {
  const params = new URLSearchParams()
  if (includeArchived) params.set('include_archived', 'true')
  const url = `${brokerBaseUrl(deps.brokerPort)}/topics?${params.toString()}`
  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(url)
  if (data.topics.length === 0) {
    return 'No active local topics.'
  }
  const statusLabel: Record<string, string> = {
    active: '[active]',
    archived: '[archived]',
  }
  const lines = ['Local topics:']
  for (const t of data.topics) {
    const joined = deps.context.isTopicJoined(t.id) ? ' <-- joined' : ''
    const active = t.id === (deps.context.hasTopic() ? deps.context.getThreadTs() : null) ? ' (active)' : ''
    lines.push(`  ${statusLabel[t.state] ?? `[${t.state}]`} "${t.topic}" (${t.messageCount ?? 0} messages)${joined}${active}`)
  }
  return lines.join('\n')
}

async function handleLocalStartTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  const res = await fetch(`${brokerBaseUrl(deps.brokerPort)}/topics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, creator: deps.session.displayName }),
  })
  if (res.status === 409) {
    const body = await res.json() as { error: string }
    return body.error
  }
  if (!res.ok) {
    throw new Error(`Broker request failed (${res.status}): ${await res.text()}`)
  }
  const data = await res.json() as BrokerTopicData
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

async function handleLocalArchiveTopic(deps: TopicToolDeps, topicId: string): Promise<string> {
  const topicName = deps.context.getTopicName() ?? 'topic'
  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${topicId}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivedBy: deps.session.displayName }),
  })
  deps.context.leaveTopic(topicId)
  return `Topic "${topicName}" archived.`
}

async function handleLocalArchiveTopicByName(deps: TopicToolDeps, name: string): Promise<string> {
  const id = await resolveLocalTopicId(deps.brokerPort, name)
  if (id.error) return id.error
  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${id.id}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivedBy: deps.session.displayName }),
  })
  deps.context.leaveTopic(id.id!)
  return `Topic "${id.topicName}" archived.`
}

async function handleLocalUnarchiveTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  if (UUID_PATTERN.test(topic)) {
    const byId = await fetchLocalTopicById(deps.brokerPort, topic)
    if (!byId || byId.state !== 'archived') return `No archived local topic with id "${topic}".`
    await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${byId.id}/unarchive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    return `Local topic "${byId.topic}" unarchived.`
  }

  const data = await brokerFetch<{ topics: BrokerTopicData[] }>(
    `${brokerBaseUrl(deps.brokerPort)}/topics?include_archived=true`
  )
  const archived = data.topics.filter((t) => t.state === 'archived')
  const { match, ambiguous } = pickMatch(archived, topic)

  if (!match) {
    if (ambiguous.length > 1) {
      const lines = [`Multiple archived local topics match "${topic}". Be more specific:`]
      for (const m of ambiguous) lines.push(`  "${m.topic}"`)
      return lines.join('\n')
    }
    return `No archived local topic matching "${topic}".`
  }

  await brokerFetch<{ ok: boolean }>(`${brokerBaseUrl(deps.brokerPort)}/topics/${match.id}/unarchive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  return `Local topic "${match.topic}" unarchived.`
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
