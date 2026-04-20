import type { ActiveContext } from '../context.js'
import type { SessionManager } from '../session.js'
import {
  DmDeliveryError,
  TopicNameConflictError,
  type ChannelLocation,
  type Transport,
  type TransportTopic,
} from '../transport/index.js'
import type { TransportRouter } from '../transport/router.js'
import { normalizeChannelName } from '../context.js'

export interface TopicToolDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Topic augmented with the transport that produced it. Used for cross-
 *  transport name-based resolution and for list_topics output. */
interface LocatedTopic extends TransportTopic {
  location: ChannelLocation
}

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

const NO_NAME_ERROR = JSON.stringify({
  error:
    'No name set. Call introduce first (e.g. "architect", "frontend"). If the user has not specified a name, ASK THE USER what name this session should use before proceeding.',
})

export function createTopicTools() {
  return [
    {
      name: 'list_topics',
      description:
        'Return topics as JSON array: [{id, name, channel, location, state, messageCount, isJoined, isMyActive, creator, createdAt}]. With no channel, scopes across all subscribed channels on every enabled transport. Optional `location` restricts to one transport.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: {
            type: 'string' as const,
            description: 'Channel to scope to. Defaults to all subscribed channels.',
          },
          include_archived: { type: 'boolean' as const, description: 'Include archived topics (default: false)' },
          location: {
            type: 'string' as const,
            enum: ['local', 'remote'],
            description: 'Transport location. Omit to query all enabled locations.',
          },
        },
        required: [],
      },
    },
    {
      name: 'start_topic',
      description:
        'Create a topic in a channel (defaults to the active channel). `location` selects the transport (defaults to the active channel\'s location, or "local"). Returns {id, name, channel, location}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name / title' },
          channel: {
            type: 'string' as const,
            description: 'Channel to create the topic in. Defaults to active channel.',
          },
          location: {
            type: 'string' as const,
            enum: ['local', 'remote'],
            description: "Transport location of the target channel. Defaults to the active channel's location.",
          },
        },
        required: ['topic'],
      },
    },
    {
      name: 'join_topic',
      description:
        'Join a topic by name (fuzzy match) or id. Topic id format routes to the owning transport automatically. Returns {id, name, channel, location, history}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name (fuzzy match) or id' },
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
      description: 'Set the active topic among joined topics. Returns {id, name, channel, location}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string' as const, description: 'Topic name or id of a joined topic.' },
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
      description: 'Unarchive a previously archived topic. Returns {id, name, channel, location}.',
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
      description:
        'Return visible sessions as JSON array: [{name, objective?, channels: [{name, location}], registeredAt}]. Unions across every enabled transport. Duplicate sessions (same name on both) are merged.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: {
            type: 'string' as const,
            description: 'Channel to scope to. Defaults to all your subscribed channels.',
          },
          location: {
            type: 'string' as const,
            enum: ['local', 'remote'],
            description: 'Transport location. Omit to query all enabled locations.',
          },
        },
      },
    },
    {
      name: 'send_message_to_session',
      description:
        'Send a private direct message to another session. Routes by recipient presence: prefers local when both know them. Returns {to, viaChannel?}.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: {
            type: 'string' as const,
            description: 'Recipient session name (must match their introduced name exactly)',
          },
          text: { type: 'string' as const, description: 'Message text' },
        },
        required: ['to', 'text'],
      },
    },
  ]
}

const REQUIRES_NAME = new Set([
  'start_topic',
  'join_topic',
  'leave_topic',
  'set_active_topic',
  'archive_topic',
  'unarchive_topic',
  'send_message_to_topic',
  'list_sessions',
  'send_message_to_session',
])

export async function handleTopicTool(
  name: string,
  args: Record<string, unknown>,
  deps: TopicToolDeps,
): Promise<string> {
  if (REQUIRES_NAME.has(name) && !deps.session.hasName()) {
    return NO_NAME_ERROR
  }

  switch (name) {
    case 'list_topics': {
      const { channel, include_archived, location } = args as {
        channel?: string
        include_archived?: boolean
        location?: ChannelLocation
      }
      return handleListTopics(deps, channel, include_archived, location)
    }
    case 'start_topic': {
      const { topic, channel, location } = args as {
        topic: string
        channel?: string
        location?: ChannelLocation
      }
      return handleStartTopic(deps, topic, channel, location)
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
        return JSON.stringify({
          error: '`text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)',
        })
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
      return JSON.stringify({
        error: 'No active topic. Use join_topic or start_topic first, or pass a `topic` argument.',
      })
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
      try {
        const transport = resolveTopicTransport(deps, threadTs)
        await transport.leaveTopic({ sessionName: deps.session.displayName, topicId: threadTs })
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      }
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
      const { channel, location } = args as { channel?: string; location?: ChannelLocation }
      return handleListSessions(deps, channel, location)
    }
    case 'send_message_to_session': {
      const { to, text } = args as { to: string; text: string }
      if (typeof text !== 'string' || text.trim() === '') {
        return JSON.stringify({
          error: '`text` is required and must be a non-empty string. (Not `message`, `content`, or anything else.)',
        })
      }
      if (typeof to !== 'string' || to.trim() === '') {
        return JSON.stringify({ error: '`to` is required and must be a non-empty string.' })
      }
      return handleSendMessageToSession(deps, to, text)
    }
    default:
      throw new Error(`Unknown topic tool: ${name}`)
  }
}

async function handleListTopics(
  deps: TopicToolDeps,
  channelArg?: string,
  includeArchived?: boolean,
  locationFilter?: ChannelLocation,
): Promise<string> {
  const located: LocatedTopic[] = []
  const transports = deps.router.enabled().filter((t) => !locationFilter || t.source === locationFilter)

  if (channelArg) {
    const channel = normalizeChannelName(channelArg)
    if (!channel) return JSON.stringify({ error: 'Channel name must be non-empty.' })
    // Find which transport(s) the channel is subscribed on. When a
    // location filter is supplied we only look at that one.
    const eligible = transports.filter((t) => deps.context.isChannelSubscribed(channel, t.source))
    if (eligible.length === 0) {
      return JSON.stringify({ error: `Not subscribed to "${channel}". Use join_channel first.` })
    }
    for (const transport of eligible) {
      try {
        const rows = await transport.listTopics({ channel, includeArchived })
        for (const r of rows) located.push({ ...r, location: transport.source })
      } catch {
        // Transport unreachable: skip.
      }
    }
  } else {
    for (const transport of transports) {
      try {
        const rows = await transport.listTopics({ sessionName: deps.session.displayName, includeArchived })
        for (const r of rows) located.push({ ...r, location: transport.source })
      } catch {
        // Transport unreachable: skip.
      }
    }
  }

  const activeThread = deps.context.hasTopic() ? deps.context.getThreadTs() : null
  const result = located.map((t) => ({
    id: t.id,
    name: t.topic,
    channel: t.channel,
    location: t.location,
    state: t.state,
    messageCount: t.messageCount ?? 0,
    isJoined: deps.context.isTopicJoined(t.id),
    isMyActive: t.id === activeThread,
    creator: t.creator,
    createdAt: t.createdAt,
  }))
  return JSON.stringify(result)
}

async function handleStartTopic(
  deps: TopicToolDeps,
  topic: string,
  channelArg?: string,
  locationArg?: ChannelLocation,
): Promise<string> {
  let channel = channelArg ? normalizeChannelName(channelArg) : undefined
  let location: ChannelLocation | undefined = locationArg

  if (channel && !location) {
    // Infer location from context: if we're subscribed to that channel
    // at exactly one location, use it.
    location = deps.context.getChannelLocation(channel)
  }
  if (!channel) {
    const active = deps.context.getActiveChannelRef()
    if (active) {
      channel = active.name
      location = location ?? active.location
    }
  }

  if (!channel) {
    return JSON.stringify({
      error: 'No active channel. Join a channel first with join_channel, or pass a `channel` argument.',
    })
  }
  if (!location) {
    return JSON.stringify({ error: `Not subscribed to "${channel}". Use join_channel first.` })
  }
  if (!deps.context.isChannelSubscribed(channel, location)) {
    return JSON.stringify({ error: `Not subscribed to "${channel}" (${location}). Use join_channel first.` })
  }

  let transport
  try {
    transport = deps.router.getByLocation(location)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }

  try {
    const data = await transport.createTopic({
      sessionName: deps.session.displayName,
      channel,
      topic,
    })
    deps.context.joinTopic(data.id, topic, data.channel ?? channel, location)
    return JSON.stringify({ id: data.id, name: topic, channel: data.channel ?? channel, location })
  } catch (err) {
    if (err instanceof TopicNameConflictError) {
      return JSON.stringify({ error: err.message, channel, location, name: topic })
    }
    throw err
  }
}

async function handleJoinTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  // Id path: route by the transport that claims the id.
  if (looksLikeTopicId(topic)) {
    let transport: Transport
    try {
      transport = deps.router.getByTopicId(topic)
    } catch {
      // Fall through to name-based resolution - the id might not be
      // known yet (e.g. a convex id the remote transport hasn't cached).
      // We still try the name path below.
      return JSON.stringify({ error: `No topic with id "${topic}" known to any transport.` })
    }
    const byId = await transport.getTopicById({ sessionName: deps.session.displayName, topicId: topic })
    if (!byId) return JSON.stringify({ error: `No topic with id "${topic}" found.` })
    if (!deps.context.isChannelSubscribed(byId.channel, transport.source)) {
      return JSON.stringify({
        error: `Topic "${byId.topic}" is in channel "${byId.channel}" (${transport.source}), which you are not subscribed to. Use join_channel first.`,
        channel: byId.channel,
        location: transport.source,
        name: byId.topic,
      })
    }
    return joinTopicByData(deps, byId, transport)
  }

  // Name path: fan out across every enabled transport, tag with
  // location, then do the fuzzy match over the union.
  const located = await listTopicsAcrossTransports(deps)
  const { match, ambiguous } = pickMatch(located, topic)

  if (!match) {
    if (ambiguous.length > 1) {
      return JSON.stringify({
        error: `Multiple topics match "${topic}". Be more specific.`,
        matches: ambiguous.map((m) => ({ id: m.id, name: m.topic, channel: m.channel, location: m.location })),
      })
    }
    return JSON.stringify({ error: `No active topic matching "${topic}" found in your subscribed channels.` })
  }

  const transport = deps.router.getByLocation(match.location)
  return joinTopicByData(deps, match, transport)
}

async function handleSetActiveTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  const found = deps.context.findJoinedTopic(topic)
  if (!found) {
    return JSON.stringify({ error: `No joined topic matching "${topic}". Use join_topic first.` })
  }
  deps.context.joinTopic(found.threadTs, found.topicName, found.channel, found.location)
  return JSON.stringify({ id: found.threadTs, name: found.topicName, channel: found.channel, location: found.location })
}

async function joinTopicByData(
  deps: TopicToolDeps,
  topic: LocatedTopic | (TransportTopic & { location?: ChannelLocation }),
  transport: Transport,
): Promise<string> {
  const location = (topic as LocatedTopic).location ?? transport.source
  const { history } = await transport.joinTopic({
    sessionName: deps.session.displayName,
    topicId: topic.id,
  })
  deps.context.joinTopic(topic.id, topic.topic, topic.channel, location)
  return JSON.stringify({
    id: topic.id,
    name: topic.topic,
    channel: topic.channel,
    location,
    history,
  })
}

async function handleSendMessage(deps: TopicToolDeps, text: string, topicId: string): Promise<string> {
  let transport
  try {
    transport = resolveTopicTransport(deps, topicId)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
  await transport.sendTopicMessage({ sessionName: deps.session.displayName, topicId, text })
  return JSON.stringify({ topicId })
}

async function handleArchiveTopic(deps: TopicToolDeps, topicId: string): Promise<string> {
  const topicName = deps.context.getTopicName() ?? 'topic'
  let transport
  try {
    transport = resolveTopicTransport(deps, topicId)
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  }
  await transport.archiveTopic({ sessionName: deps.session.displayName, topicId })
  deps.context.leaveTopic(topicId)
  return JSON.stringify({ id: topicId, name: topicName })
}

async function handleArchiveTopicByName(deps: TopicToolDeps, name: string): Promise<string> {
  const resolved = await resolveTopicIdInSubscribedChannels(deps, name)
  if ('error' in resolved) return JSON.stringify(resolved)
  const transport = deps.router.getByLocation(resolved.location)
  await transport.archiveTopic({ sessionName: deps.session.displayName, topicId: resolved.id })
  deps.context.leaveTopic(resolved.id)
  return JSON.stringify({ id: resolved.id, name: resolved.topicName })
}

/**
 * Pick the transport that should handle an operation on a topic id.
 *
 * Strategy:
 *   1. If the context knows about this topic (session joined it), use
 *      the stored location. Context is the single source of truth for
 *      joined topics and it covers the common path without any
 *      runtime id-shape assumptions.
 *   2. Otherwise delegate to `router.getByTopicId`, which inspects each
 *      transport's `hasTopic`. This covers the "join by id" flow where
 *      the id has not yet been added to context.
 */
function resolveTopicTransport(deps: TopicToolDeps, topicId: string): Transport {
  const storedLocation = deps.context.getJoinedTopicLocation(topicId)
  if (storedLocation !== undefined) {
    return deps.router.getByLocation(storedLocation)
  }
  return deps.router.getByTopicId(topicId)
}

async function handleUnarchiveTopic(deps: TopicToolDeps, topic: string): Promise<string> {
  if (looksLikeTopicId(topic)) {
    let transport
    try {
      transport = deps.router.getByTopicId(topic)
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
    }
    const byId = await transport.getTopicById({ sessionName: deps.session.displayName, topicId: topic })
    if (!byId || byId.state !== 'archived') return JSON.stringify({ error: `No archived topic with id "${topic}".` })
    if (!deps.context.isChannelSubscribed(byId.channel, transport.source)) {
      return JSON.stringify({
        error: `Topic "${byId.topic}" is in "${byId.channel}" (${transport.source}), which you are not subscribed to. Use join_channel first.`,
        channel: byId.channel,
        location: transport.source,
        name: byId.topic,
      })
    }
    try {
      await transport.unarchiveTopic({ sessionName: deps.session.displayName, topicId: byId.id })
    } catch (err) {
      if (err instanceof TopicNameConflictError) {
        return JSON.stringify({
          error: err.message,
          channel: byId.channel,
          location: transport.source,
          name: byId.topic,
        })
      }
      throw err
    }
    return JSON.stringify({ id: byId.id, name: byId.topic, channel: byId.channel, location: transport.source })
  }

  const located = await listTopicsAcrossTransports(deps, { includeArchived: true })
  const archived = located.filter((t) => t.state === 'archived')
  const { match, ambiguous } = pickMatch(archived, topic)

  if (!match) {
    if (ambiguous.length > 1) {
      return JSON.stringify({
        error: `Multiple archived topics match "${topic}". Be more specific.`,
        matches: ambiguous.map((m) => ({ id: m.id, name: m.topic, channel: m.channel, location: m.location })),
      })
    }
    return JSON.stringify({ error: `No archived topic matching "${topic}" in your subscribed channels.` })
  }

  const transport = deps.router.getByLocation(match.location)
  try {
    await transport.unarchiveTopic({ sessionName: deps.session.displayName, topicId: match.id })
  } catch (err) {
    if (err instanceof TopicNameConflictError) {
      return JSON.stringify({ error: err.message, channel: match.channel, location: match.location, name: match.topic })
    }
    throw err
  }
  return JSON.stringify({ id: match.id, name: match.topic, channel: match.channel, location: match.location })
}

async function handleListSessions(
  deps: TopicToolDeps,
  channelArg?: string,
  locationFilter?: ChannelLocation,
): Promise<string> {
  const transports = deps.router.enabled().filter((t) => !locationFilter || t.source === locationFilter)

  // Merged by session name. Channels union across transports, each
  // tagged by the location it came from.
  const merged = new Map<
    string,
    {
      name: string
      objective?: string
      channels: Array<{ name: string; location: ChannelLocation }>
      registeredAt?: string
    }
  >()

  if (channelArg) {
    const channel = normalizeChannelName(channelArg)
    if (!channel) return JSON.stringify({ error: 'Channel name must be non-empty.' })
    const eligible = transports.filter((t) => deps.context.isChannelSubscribed(channel, t.source))
    if (eligible.length === 0) {
      return JSON.stringify({ error: `Not subscribed to "${channel}". Use join_channel first.` })
    }
    for (const transport of eligible) {
      try {
        const sessions = await transport.listSessions({ channel })
        mergeSessions(merged, sessions, transport.source)
      } catch {
        // transport unreachable, skip
      }
    }
  } else {
    for (const transport of transports) {
      try {
        const sessions = await transport.listSessions({})
        mergeSessions(merged, sessions, transport.source)
      } catch {
        // transport unreachable, skip
      }
    }
  }

  // Without an explicit channel: filter to sessions sharing at least
  // one channel with us. `subscribed` includes (name, location) pairs,
  // so the check is location-aware.
  const mySubs = new Set(deps.context.getSubscribedChannels().map((c) => `${c.location}::${c.name}`))
  const visible = channelArg
    ? [...merged.values()]
    : [...merged.values()].filter((s) => {
        if (s.channels.length === 0) return false
        return s.channels.some((ch) => mySubs.has(`${ch.location}::${ch.name}`))
      })

  const result = visible.map((s) => ({
    name: s.name,
    ...(s.objective ? { objective: s.objective } : {}),
    channels: s.channels,
    registeredAt: s.registeredAt,
  }))
  return JSON.stringify(result)
}

function mergeSessions(
  merged: Map<
    string,
    {
      name: string
      objective?: string
      channels: Array<{ name: string; location: ChannelLocation }>
      registeredAt?: string
    }
  >,
  rows: Array<{ name: string; objective?: string; channels?: string[]; registeredAt?: string }>,
  location: ChannelLocation,
): void {
  for (const r of rows) {
    const existing = merged.get(r.name)
    const tagged = (r.channels ?? []).map((c) => ({ name: c, location }))
    if (existing) {
      existing.objective = existing.objective ?? r.objective
      // Union channels; same (name, location) tuples dedupe themselves
      // because this stage runs per-location.
      const seen = new Set(existing.channels.map((c) => `${c.location}::${c.name}`))
      for (const t of tagged) {
        const key = `${t.location}::${t.name}`
        if (!seen.has(key)) {
          existing.channels.push(t)
          seen.add(key)
        }
      }
      existing.registeredAt = existing.registeredAt ?? r.registeredAt
    } else {
      merged.set(r.name, {
        name: r.name,
        objective: r.objective,
        channels: tagged,
        registeredAt: r.registeredAt,
      })
    }
  }
}

async function handleSendMessageToSession(deps: TopicToolDeps, to: string, text: string): Promise<string> {
  const transports = deps.router.enabled()
  if (transports.length === 0) {
    return JSON.stringify({ error: 'No transports are enabled.' })
  }

  // Single-transport fast path: no presence check required. Matches
  // pre-CCC-3 behaviour exactly (broker owns DM routing; the
  // transport's `sendDirectMessage` is the single source of truth for
  // "recipient known / shared channel"). Avoids a round-trip on the
  // common path.
  let chosen: Transport
  if (transports.length === 1) {
    chosen = transports[0]!
  } else {
    // Multi-transport: presence check via listSessions. Prefer local
    // when both know the recipient; fall back to local when neither
    // does (delivery attempt will still surface a useful DM error).
    const owners: Transport[] = []
    for (const transport of transports) {
      try {
        const sessions = await transport.listSessions({})
        if (sessions.some((s) => s.name === to)) owners.push(transport)
      } catch {
        // transport unreachable; skip
      }
    }
    if (owners.length === 1) {
      chosen = owners[0]!
    } else if (owners.length > 1) {
      chosen = owners.find((t) => t.source === 'local') ?? owners[0]!
    } else {
      chosen = transports.find((t) => t.source === 'local') ?? transports[0]!
    }
  }

  try {
    const { viaChannel } = await chosen.sendDirectMessage({
      fromSessionName: deps.session.displayName,
      toSessionName: to,
      text,
    })
    return JSON.stringify({ to, ...(viaChannel ? { viaChannel } : {}) })
  } catch (err) {
    if (err instanceof DmDeliveryError) {
      return JSON.stringify({ error: err.message })
    }
    throw err
  }
}

interface ResolvedTopic {
  id: string
  topicName: string
  location: ChannelLocation
}
interface ResolveError {
  error: string
  matches?: Array<{ id: string; name: string; channel: string; location: ChannelLocation }>
}

async function resolveTopicIdInSubscribedChannels(
  deps: TopicToolDeps,
  name: string,
): Promise<ResolvedTopic | ResolveError> {
  if (looksLikeTopicId(name)) {
    let transport: Transport
    try {
      transport = deps.router.getByTopicId(name)
    } catch {
      return { error: `No topic with id "${name}".` }
    }
    const byId = await transport.getTopicById({ sessionName: deps.session.displayName, topicId: name })
    if (!byId) return { error: `No topic with id "${name}".` }
    if (!deps.context.isChannelSubscribed(byId.channel, transport.source)) {
      return {
        error: `Topic "${byId.topic}" is in "${byId.channel}" (${transport.source}), which you are not subscribed to.`,
      }
    }
    return { id: byId.id, topicName: byId.topic, location: transport.source }
  }
  const located = await listTopicsAcrossTransports(deps)
  const { match, ambiguous } = pickMatch(located, name)
  if (!match) {
    if (ambiguous.length > 1) {
      return {
        error: `Multiple topics match "${name}". Be more specific.`,
        matches: ambiguous.map((m) => ({ id: m.id, name: m.topic, channel: m.channel, location: m.location })),
      }
    }
    return { error: `No active topic matching "${name}" in your subscribed channels.` }
  }
  return { id: match.id, topicName: match.topic, location: match.location }
}

async function listTopicsAcrossTransports(
  deps: TopicToolDeps,
  opts: { includeArchived?: boolean } = {},
): Promise<LocatedTopic[]> {
  const located: LocatedTopic[] = []
  for (const transport of deps.router.enabled()) {
    try {
      const rows = await transport.listTopics({
        sessionName: deps.session.displayName,
        includeArchived: opts.includeArchived,
      })
      for (const r of rows) located.push({ ...r, location: transport.source })
    } catch {
      // skip disabled or unreachable transport
    }
  }
  return located
}

/**
 * Does this string look like a topic id rather than a name?
 *
 * Accepts both broker UUIDs (RFC 4122) and Convex document ids
 * (base32-ish, typically 28+ chars of `[a-z0-9]`). The heuristic is a
 * gate, not a routing decision - the router then picks the transport
 * via `hasTopic`.
 */
function looksLikeTopicId(s: string): boolean {
  if (UUID_PATTERN.test(s)) return true
  // Convex ids: lowercased alphanumeric, no spaces, at least ~16 chars.
  // Names contain spaces or uppercase or short strings, so the combo
  // rules most fuzzy-match inputs out.
  return /^[a-z0-9]{16,}$/.test(s)
}
