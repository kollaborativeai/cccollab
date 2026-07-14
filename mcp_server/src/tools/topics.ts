import type { ActiveContext } from '../context.js'
import type { MessageBus } from '../message-bus.js'
import type { SessionManager } from '../session.js'
import {
  LOCAL_LOCATION,
  TopicNameConflictError,
  type ChannelLocation,
  type Transport,
  type TransportTopic,
  type TransportTopicMessage,
} from '../transport/index.js'
import type { TransportRouter } from '../transport/router.js'
import { ensureTopicSubscription, teardownTopicSubscription } from '../transport/attach.js'
import { normalizeChannelName } from '../context.js'

export interface TopicToolDeps {
  session: SessionManager
  context: ActiveContext
  router: TransportRouter
  /** Inbound message pipeline, used by the tool handlers below to push
   *  remote topic-message subscription callbacks into the MCP
   *  notification stream. Optional so older tool-layer unit tests (which
   *  don't exercise remote subscriptions) can keep constructing deps
   *  without one; the wiring degrades to a no-op when absent. */
  messageBus?: MessageBus
  /** Bring a dormant token-bearing location online before routing to it,
   *  so a remote in config works without a fresh `authenticate`. `target`
   *  names a location; omit for "every non-local". No-op for 'local' and
   *  already-attached locations. Optional so legacy unit tests that build
   *  deps by hand keep compiling. See `ensureLazyAttach`. */
  ensureAttached?: (target?: string, opts?: { force?: boolean }) => Promise<void>
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

const REQUIRES_NAME = new Set([
  'start_topic',
  'join_topic',
  'leave_topic',
  'set_active_topic',
  'archive_topic',
  'unarchive_topic',
  'send_message_to_topic',
  'list_sessions',
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
      let leavingTransportSource: string | undefined
      try {
        const transport = resolveTopicTransport(deps, threadTs)
        leavingTransportSource = transport.source
        await transport.leaveTopic({ sessionName: deps.session.displayName, topicId: threadTs })
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      }
      deps.context.leaveTopic(threadTs)
      // A DELIBERATE leave: forget the feed outright. The transport suspends it
      // on any leaveTopic (so the identity migration's transient leave/re-join
      // restores it), but here the user is done with the topic, so it must not
      // linger as "suspended" and make the location look deaf.
      if (leavingTransportSource !== undefined) {
        teardownTopicSubscription({ transport: deps.router.get(leavingTransportSource), topicId: threadTs })
      }
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
    case 'read_topic_messages': {
      const { topic, limit, before } = args as {
        topic?: string
        limit?: number
        before?: number
      }
      const active = deps.context.hasTopic() ? deps.context.getThreadTs() : undefined
      const topicId = topic ?? active
      if (!topicId) {
        return JSON.stringify({
          error: 'No active topic. Pass a `topic` id, or join one with join_topic.',
        })
      }
      // A raw topic id carries no location, so bring every dormant remote
      // online before asking which transport owns it — the user is
      // explicitly reading a (possibly remote) topic.
      await deps.ensureAttached?.()
      let transport: Transport
      try {
        transport = resolveTopicTransport(deps, topicId)
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      }
      const page = await transport.readTopicMessages({ topicId, limit, before })
      return JSON.stringify(page)
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
  await deps.ensureAttached?.(locationFilter)
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
    // No channel arg: enumerate topics across every channel the session
    // is subscribed to at each transport's location. Remote backends
    // have no efficient cross-channel listTopics query, so we must
    // fan-out per-channel; local does too and benefits from the same
    // loop. Dedup happens naturally - each (location, channel) pair
    // owns a disjoint set of topic ids.
    const subscribed = deps.context.getSubscribedChannels()
    for (const transport of transports) {
      const subsAtLocation = subscribed.filter((c) => c.location === transport.source)
      for (const { name: channel } of subsAtLocation) {
        try {
          const rows = await transport.listTopics({
            sessionName: deps.session.displayName,
            channel,
            includeArchived,
          })
          for (const r of rows) located.push({ ...r, location: transport.source })
        } catch {
          // Transport unreachable: skip.
        }
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
    // Prefer the backend's per-session membership when the transport reports
    // it: the in-memory context goes stale when the session is removed from a
    // topic elsewhere (e.g. via the web hub). Fall back to context for
    // transports that don't report `joined` (the local broker).
    isJoined: t.joined ?? deps.context.isTopicJoined(t.id),
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
    transport = deps.router.get(location)
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
    if (deps.messageBus) {
      // Brand-new topic: no history to prime past, so seed the cursor
      // to `now` to avoid replaying anything another producer may have
      // inserted between createTopic and subscribe.
      ensureTopicSubscription({
        transport,
        topicId: data.id,
        channelName: data.channel ?? channel,
        sinceTs: Date.now(),
        messageBus: deps.messageBus,
      })
    }
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

  const transport = deps.router.get(match.location)
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

/**
 * Registers the caller's session as a member of `topic`: joins on the transport
 * (creating the backing membership so `isJoined` is true on both the local
 * broker and the remote backend), records it in the local context, and — when a
 * message bus is wired — subscribes to its live updates. Shared by `join_topic`
 * and `unarchive_topic` so unarchiving revives membership the same way joining
 * establishes it. Returns the joined location and the primed message history.
 */
async function registerTopicMembership(
  deps: TopicToolDeps,
  topic: LocatedTopic | (TransportTopic & { location?: ChannelLocation }),
  transport: Transport,
): Promise<{ location: ChannelLocation; history: TransportTopicMessage[] }> {
  const location = (topic as LocatedTopic).location ?? transport.source
  const { history } = await transport.joinTopic({
    sessionName: deps.session.displayName,
    topicId: topic.id,
  })
  deps.context.joinTopic(topic.id, topic.topic, topic.channel, location)
  if (deps.messageBus) {
    // Prime the reactive cursor past whatever history we just returned
    // to the tool caller so the first `onUpdate` batch doesn't replay
    // those same messages as inbound notifications.
    let sinceTs: number | undefined
    for (const row of history) {
      const parsed = Date.parse(row.ts)
      if (Number.isNaN(parsed)) continue
      if (sinceTs === undefined || parsed > sinceTs) sinceTs = parsed
    }
    ensureTopicSubscription({
      transport,
      topicId: topic.id,
      channelName: topic.channel,
      sinceTs,
      messageBus: deps.messageBus,
    })
  }
  return { location, history }
}

async function joinTopicByData(
  deps: TopicToolDeps,
  topic: LocatedTopic | (TransportTopic & { location?: ChannelLocation }),
  transport: Transport,
): Promise<string> {
  const { location, history } = await registerTopicMembership(deps, topic, transport)
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
  // Keep the archiver's membership and live subscription: the peer stays a
  // member, so dropping only the archiver's was asymmetric — and it must stay
  // subscribed to receive the topic's own unarchive event (KAI-373).
  return JSON.stringify({ id: topicId, name: topicName })
}

async function handleArchiveTopicByName(deps: TopicToolDeps, name: string): Promise<string> {
  const resolved = await resolveTopicIdInSubscribedChannels(deps, name)
  if ('error' in resolved) return JSON.stringify(resolved)
  const transport = deps.router.get(resolved.location)
  await transport.archiveTopic({ sessionName: deps.session.displayName, topicId: resolved.id })
  // Archiving never drops membership (KAI-373); this by-name path only runs for
  // topics the session hasn't joined, so there's nothing to leave anyway.
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
    return deps.router.get(storedLocation)
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
    // Join the acting session to the now-active topic so it's a member again
    // (KAI-373). Must run after unarchive — join rejects archived topics. A
    // transient failure here surfaces as an error; the topic is already active,
    // so the caller can recover with join_topic.
    await registerTopicMembership(deps, byId, transport)
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

  const transport = deps.router.get(match.location)
  try {
    await transport.unarchiveTopic({ sessionName: deps.session.displayName, topicId: match.id })
  } catch (err) {
    if (err instanceof TopicNameConflictError) {
      return JSON.stringify({ error: err.message, channel: match.channel, location: match.location, name: match.topic })
    }
    throw err
  }
  // Join the acting session to the now-active topic so it's a member again
  // (KAI-373); see the id-path above for the ordering/failure rationale.
  await registerTopicMembership(deps, match, transport)
  return JSON.stringify({ id: match.id, name: match.topic, channel: match.channel, location: match.location })
}

async function handleListSessions(
  deps: TopicToolDeps,
  channelArg?: string,
  locationFilter?: ChannelLocation,
): Promise<string> {
  await deps.ensureAttached?.(locationFilter)
  const transports = deps.router.enabled().filter((t) => !locationFilter || t.source === locationFilter)

  // Merged by session name. Channels union across transports, each
  // tagged by the location it came from.
  //
  // `scopedLocations` records locations whose transport already scopes
  // `listSessions` server-side to peers sharing a channel with this
  // session (every non-local transport does). Such a session is a
  // confirmed peer even when the transport can't denormalize *which*
  // channels — see the `visible` filter below.
  const merged = new Map<
    string,
    {
      name: string
      objective?: string
      channels: Array<{ name: string; location: ChannelLocation }>
      registeredAt?: string
      scopedLocations: Set<ChannelLocation>
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
        mergeSessions(merged, sessions, transport.source, transport.source !== LOCAL_LOCATION)
      } catch {
        // transport unreachable, skip
      }
    }
  } else {
    for (const transport of transports) {
      try {
        const sessions = await transport.listSessions({})
        mergeSessions(merged, sessions, transport.source, transport.source !== LOCAL_LOCATION)
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
        // A session reported by a server-scoped transport is already a
        // confirmed shared-channel peer: the remote backend's
        // `listSessions` only returns sessions sharing a channel with
        // us, even though it doesn't denormalize which ones. Keep it
        // regardless of the (empty) `channels` list.
        if (s.scopedLocations.size > 0) return true
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
      scopedLocations: Set<ChannelLocation>
    }
  >,
  rows: Array<{ name: string; objective?: string; channels?: string[]; registeredAt?: string }>,
  location: ChannelLocation,
  /** True when this transport's `listSessions` is already scoped
   *  server-side to peers sharing a channel with the caller. */
  serverScoped: boolean,
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
      if (serverScoped) existing.scopedLocations.add(location)
    } else {
      merged.set(r.name, {
        name: r.name,
        objective: r.objective,
        channels: tagged,
        registeredAt: r.registeredAt,
        scopedLocations: serverScoped ? new Set([location]) : new Set(),
      })
    }
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
  // Fan out per (transport, subscribed channel at that location). The
  // remote transport's `listTopics` requires a channel arg server-side
  // (the Convex `topics.queries.listByChannel` query has no
  // cross-channel variant), so calling it without one returns []. To
  // keep behaviour uniform — and because the union we actually want is
  // "topics in channels I'm subscribed to" — we always pass a channel
  // and iterate. Without this, fuzzy `join_topic <name>` against a
  // remote topic silently fails: the name path resolves through
  // listTopicsAcrossTransports.
  const located: LocatedTopic[] = []
  const subscribed = deps.context.getSubscribedChannels()
  for (const transport of deps.router.enabled()) {
    const channelsAtLocation = subscribed.filter((c) => c.location === transport.source)
    for (const { name: channel } of channelsAtLocation) {
      try {
        const rows = await transport.listTopics({
          sessionName: deps.session.displayName,
          channel,
          includeArchived: opts.includeArchived,
        })
        for (const r of rows) located.push({ ...r, location: transport.source })
      } catch {
        // skip disabled or unreachable transport
      }
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
