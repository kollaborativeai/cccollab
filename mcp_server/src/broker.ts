#!/usr/bin/env npx tsx
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import {
  PROFILE,
  BROKER_RENDEZVOUS_FILE,
  CCCOLLAB_RUN_DIR,
  CCCOLLAB_LOGS_DIR,
  DEFAULT_BROKER_HEARTBEAT_MS,
  parsePositiveInt,
} from './constants.js'
import { removeRendezvous } from './broker-discovery.js'
import { clampHistoryLimit, pageTopicHistory } from './history-paging.js'

mkdirSync(CCCOLLAB_RUN_DIR, { recursive: true })
mkdirSync(CCCOLLAB_LOGS_DIR, { recursive: true })

const PID_FILE = join(CCCOLLAB_RUN_DIR, `${PROFILE}.pid`)
const LOG_FILE = join(CCCOLLAB_LOGS_DIR, `${PROFILE}.log`)

type SSEResponse = ServerResponse & { req: IncomingMessage }

const clients = new Set<SSEResponse>()

/** Identifies THIS broker process. A restarted broker starts its sequence over,
 *  so a cursor carrying a different id cannot be honoured — and the client must
 *  be told that, not silently resumed from nothing. */
const BROKER_ID = crypto.randomUUID()
/** Read a positive-integer tuning knob from the environment. Rejects garbage
 *  rather than silently coercing to NaN: every one of these knobs degrades
 *  SILENTLY when it is NaN (eviction never fires because `length > NaN` is
 *  false; an interval fires every tick), and silent degradation is the exact
 *  failure mode this stream work exists to eliminate. */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = parsePositiveInt(raw)
  if (n === undefined) {
    // The broker is typically spawned with stdio ignored, so a bare throw is a
    // 10s hang and a generic rendezvous timeout that names neither variable
    // nor value. Write the reason to the log file before dying so the operator
    // has somewhere to look.
    try {
      log(`${name} must be an integer >= 1, got ${JSON.stringify(raw)}`)
    } catch {
      /* LOG_FILE may not be writable; the throw is the real signal. */
    }
    throw new Error(`${name} must be an integer >= 1, got ${JSON.stringify(raw)}`)
  }
  return n
}

/** Events retained for replay to a reconnecting client. Bounded: a client that
 *  falls further behind than this gets an explicit `stream_gap`, never a
 *  quietly-incomplete replay. */
const REPLAY_CAPACITY = positiveIntEnv('CCCOLLAB_REPLAY_CAPACITY', 1000)
/** How often every open SSE stream gets a comment frame. Its job is to make
 *  silence MEAN something: a client can only tell "quiet but healthy" from
 *  "wedged" if a healthy stream is never silent for long. The listener's read
 *  deadline is DERIVED from this same variable (`readDeadlineMsFor` in
 *  broker-event-listener.ts) rather than tracking it by hand: while it was a
 *  literal on that side, raising this knob past the deadline made every session
 *  reconnect-loop against a healthy broker (cc#35). */
const HEARTBEAT_MS = positiveIntEnv('CCCOLLAB_HEARTBEAT_MS', DEFAULT_BROKER_HEARTBEAT_MS)
const replayBuffer: Array<{ seq: number; data: string }> = []
let lastSeq = 0

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  appendFileSync(LOG_FILE, line)
}

function writeToClients(payload: string): void {
  // ServerResponse.write() does NOT throw synchronously on a dead socket — the
  // try/catch that used to wrap this never fired. Dead clients are removed by
  // the `error` and `close` handlers registered when they join the set.
  for (const client of clients) {
    client.write(payload)
  }
}

function broadcast(data: string): void {
  lastSeq += 1
  replayBuffer.push({ seq: lastSeq, data })
  if (replayBuffer.length > REPLAY_CAPACITY) replayBuffer.shift()
  writeToClients(sseFrame(`${BROKER_ID}:${lastSeq}`, data))
}

/** An SSE comment frame: no `id:`, no `data:`. That is what makes it safe to
 *  send into a cursored stream — clients skip it without advancing their
 *  cursor, and it consumes no sequence number, so a reconnect resumes exactly
 *  where it would have anyway. */
const HEARTBEAT_FRAME = ': ping\n\n'

// One timer for every client rather than one per client: they all want the
// same frame at the same time. `.unref()` because a heartbeat must never be
// the reason this process stays alive — the HTTP server is.
setInterval(() => writeToClients(HEARTBEAT_FRAME), HEARTBEAT_MS).unref()

function sseFrame(id: string | undefined, data: string): string {
  return `${id ? `id: ${id}\n` : ''}data: ${data}\n\n`
}

/** What can we still deliver to a client resuming from `lastEventId`?
 *  `replay` is what it missed; `gap` is set when the cursor cannot be honoured
 *  at all, which the client must hear about rather than infer from silence. */
function resumeFrom(lastEventId: string | undefined): { replay: typeof replayBuffer; gap?: string } {
  if (!lastEventId) return { replay: [] } // fresh client: forward-only by design
  // `Number('')` is 0, `Number('1e2')` is 100, `split(':')` discards extra
  // segments — any of those would either replay everything with NO gap or
  // accept a forgeable cursor. Sequence numbers are non-negative integers only.
  const parts = lastEventId.split(':')
  const brokerId = parts[0]
  const rawSeq = parts[1]
  if (parts.length !== 2 || !brokerId || rawSeq === undefined || !/^\d+$/.test(rawSeq)) {
    return { replay: [], gap: `cursor "${lastEventId}" is not a position this broker ever issued` }
  }
  const since = Number(rawSeq)
  if (brokerId !== BROKER_ID) {
    return { replay: [], gap: 'cursor is from a previous broker instance; its events are gone' }
  }
  if (!Number.isFinite(since) || since < 0 || since > lastSeq) {
    return { replay: [], gap: `cursor "${lastEventId}" is not a position this broker ever issued` }
  }
  // A client behind lastSeq needs proof we still hold its next event. When the
  // buffer is empty the only safe answer is "gap" — a silent zero-length
  // replay is the confidently-blind failure this ticket exists to kill.
  // (REPLAY_CAPACITY cannot be 0: positiveIntEnv refuses n < 1 at boot. The
  // empty-buffer arm still runs after eviction of everything, or a brand-new
  // broker that has not yet published.)
  const oldest = replayBuffer[0]
  if (since < lastSeq && (!oldest || since < oldest.seq - 1)) {
    // Still hand back whatever we hold. Returning `replay: []` alone threw away
    // up to REPLAY_CAPACITY events the client has never seen; stream_hello then
    // jumps their cursor to lastSeq and those events are gone forever.
    return {
      replay: replayBuffer.filter((e) => e.seq > since),
      gap: `client fell more than ${REPLAY_CAPACITY} events behind; the missed events have been evicted`,
    }
  }
  return { replay: replayBuffer.filter((e) => e.seq > since) }
}

interface LocalTopicMessage {
  sender: string
  text: string
  ts: string
}

interface LocalTopic {
  id: string
  topic: string
  channel: string
  creator: string
  state: 'active' | 'archived'
  createdAt: string
  messages: LocalTopicMessage[]
  joinedSessions: Set<string>
}

interface SessionInfo {
  name: string
  objective?: string
  registeredAt: string
  channels: Set<string>
}

const topics = new Map<string, LocalTopic>()
const sessions = new Map<string, SessionInfo>()
const channels = new Map<string, Set<string>>()

/** Normalize channel name: trim + lowercase. Returns null if empty. */
function normalizeChannel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

function ensureSession(name: string): SessionInfo {
  let info = sessions.get(name)
  if (!info) {
    info = { name, registeredAt: new Date().toISOString(), channels: new Set() }
    sessions.set(name, info)
  }
  return info
}

function joinChannel(sessionName: string, channel: string): boolean {
  const info = ensureSession(sessionName)
  const already = info.channels.has(channel)
  info.channels.add(channel)
  let members = channels.get(channel)
  if (!members) {
    members = new Set()
    channels.set(channel, members)
  }
  members.add(sessionName)
  return !already
}

function leaveChannel(sessionName: string, channel: string): boolean {
  const info = sessions.get(sessionName)
  if (!info) return false
  const removed = info.channels.delete(channel)
  const members = channels.get(channel)
  if (members) {
    members.delete(sessionName)
    if (members.size === 0) channels.delete(channel)
  }
  for (const t of topics.values()) {
    if (t.channel === channel) t.joinedSessions.delete(sessionName)
  }
  return removed
}

function removeSessionFromAllChannels(sessionName: string): void {
  const info = sessions.get(sessionName)
  if (!info) return
  for (const ch of [...info.channels]) {
    leaveChannel(sessionName, ch)
  }
}

const MAX_BODY_SIZE = 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function parseUrl(url: string): { pathname: string; searchParams: URLSearchParams } {
  const parsed = new URL(url, 'http://localhost')
  return { pathname: parsed.pathname, searchParams: parsed.searchParams }
}

const TOPIC_ID_ROUTE = /^\/topics\/([^/]+)$/
const TOPIC_ACTION_ROUTE = /^\/topics\/([^/]+)\/(messages|join|leave|archive|unarchive)$/
const TOPIC_MESSAGES_ROUTE = /^\/topics\/([^/]+)\/messages$/
const SESSION_NAME_ROUTE = /^\/sessions\/([^/]+)$/

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const { pathname, searchParams } = parseUrl(req.url ?? '/')
  const method = req.method ?? 'GET'

  if (pathname === '/health' && method === 'GET') {
    jsonResponse(res, 200, { ok: true, connections: clients.size })
    return
  }

  if (pathname === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const sseRes = res as SSEResponse
    // Push the headers now instead of waiting for the first event: SSE clients
    // (and the event listener) need a live connection immediately, before any
    // broadcast, so they don't miss events that fire right after connecting.
    res.flushHeaders()

    // Resume BEFORE registering as a live client: this handler is synchronous,
    // so no broadcast can interleave, and the client sees the replay and the
    // live stream in one unbroken order.
    //
    // The resume/replay writes run BEFORE the client is in `clients` and before
    // any error handler is attached. An exception here would escape the request
    // listener and kill the daemon — every session on the machine goes deaf at
    // once. Guard the whole burst; on failure abandon this client rather than
    // the process.
    const { replay, gap } = resumeFrom(req.headers['last-event-id'] as string | undefined)
    try {
      if (gap) {
        res.write(sseFrame(undefined, JSON.stringify({ source: 'local', type: 'stream_gap', reason: gap })))
        log(`SSE client resumed with an UNFILLABLE cursor: ${gap}`)
      }
      for (const event of replay) {
        res.write(sseFrame(`${BROKER_ID}:${event.seq}`, event.data))
      }
      if (replay.length > 0) log(`SSE client resumed: replayed ${replay.length} missed event(s)`)

      // Hand the client a cursor IMMEDIATELY, before it has heard any traffic. A
      // listener whose cursor only exists after its first event has none at all
      // during the quiet window — and a drop there would silently swallow
      // everything published in the gap. The quiet watcher is precisely the one
      // this feature exists to protect.
      res.write(sseFrame(`${BROKER_ID}:${lastSeq}`, JSON.stringify({ source: 'local', type: 'stream_hello' })))
    } catch (err) {
      log(`SSE resume write failed: ${err instanceof Error ? err.message : String(err)}`)
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
      return
    }

    clients.add(sseRes)
    // write() never throws on a dead socket; 'error' is the real signal.
    // Without this, an 'error' with no listener becomes an uncaught throw.
    sseRes.on('error', () => {
      clients.delete(sseRes)
    })
    log(`SSE client connected (total: ${clients.size})`)

    req.on('close', () => {
      clients.delete(sseRes)
      log(`SSE client disconnected (total: ${clients.size})`)
    })
    return
  }

  if (pathname === '/local-event' && method === 'POST') {
    void (async () => {
      try {
        const event = JSON.parse(await readBody(req)) as Record<string, unknown>
        if (!event.type) {
          jsonResponse(res, 400, { error: 'type is required' })
          return
        }
        const payload = { source: 'local', ...event }
        broadcast(JSON.stringify(payload))
        log(`LOCAL EVENT: ${JSON.stringify(payload).slice(0, 200)}`)
        jsonResponse(res, 200, { ok: true })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  if (pathname === '/channels' && method === 'GET') {
    const sessionId = searchParams.get('sessionId') ?? undefined
    // The broker has no user accounts — every channel member is a session — so
    // `subscriberCount` and `sessionCount` are the same value here. Both are
    // reported so the `list_channels` tool output is uniform across transports.
    if (sessionId) {
      const info = sessions.get(sessionId)
      const result: Array<{ name: string; subscriberCount: number; sessionCount: number }> = []
      if (info) {
        for (const ch of info.channels) {
          const size = channels.get(ch)?.size ?? 0
          result.push({ name: ch, subscriberCount: size, sessionCount: size })
        }
      }
      jsonResponse(res, 200, { channels: result })
      return
    }
    const result: Array<{ name: string; subscriberCount: number; sessionCount: number }> = []
    for (const [name, members] of channels) {
      result.push({ name, subscriberCount: members.size, sessionCount: members.size })
    }
    jsonResponse(res, 200, { channels: result })
    return
  }

  if (pathname === '/channels/join' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { sessionId?: string; channel?: string }
        const sessionId = body.sessionId
        const channel = normalizeChannel(body.channel)
        if (!sessionId || !channel) {
          jsonResponse(res, 400, { error: 'sessionId and non-empty channel are required' })
          return
        }
        const added = joinChannel(sessionId, channel)
        log(`CHANNEL JOIN: ${sessionId} -> ${channel}${added ? '' : ' (already)'}`)
        jsonResponse(res, 200, {
          ok: true,
          channel,
          subscriberCount: channels.get(channel)?.size ?? 0,
        })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  if (pathname === '/channels/leave' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { sessionId?: string; channel?: string }
        const sessionId = body.sessionId
        const channel = normalizeChannel(body.channel)
        if (!sessionId || !channel) {
          jsonResponse(res, 400, { error: 'sessionId and non-empty channel are required' })
          return
        }
        leaveChannel(sessionId, channel)
        log(`CHANNEL LEAVE: ${sessionId} <- ${channel}`)
        jsonResponse(res, 200, { ok: true, channel })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  if (pathname === '/broadcast' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { text?: string; sender?: string; channel?: string }
        const channel = normalizeChannel(body.channel)
        if (!body.text || !body.sender || !channel) {
          jsonResponse(res, 400, { error: 'text, sender and channel are required' })
          return
        }
        const info = sessions.get(body.sender)
        if (!info || !info.channels.has(channel)) {
          jsonResponse(res, 400, { error: `Sender is not subscribed to channel "${channel}".` })
          return
        }
        const event = {
          source: 'local' as const,
          type: 'broadcast' as const,
          channel,
          sender: body.sender,
          text: body.text,
          ts: new Date().toISOString(),
        }
        broadcast(JSON.stringify(event))
        log(`BROADCAST ${channel}: ${body.sender}: ${body.text}`)
        jsonResponse(res, 200, { ok: true })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  if (pathname === '/topics' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { topic?: string; creator?: string; channel?: string }
        const channel = normalizeChannel(body.channel)
        if (!body.topic || !body.creator || !channel) {
          jsonResponse(res, 400, { error: 'topic, creator and channel are required' })
          return
        }
        const info = sessions.get(body.creator)
        if (!info || !info.channels.has(channel)) {
          jsonResponse(res, 400, { error: `Creator is not subscribed to channel "${channel}".` })
          return
        }
        const wanted = body.topic.trim().toLowerCase()
        for (const t of topics.values()) {
          if (t.state === 'active' && t.channel === channel && t.topic.trim().toLowerCase() === wanted) {
            jsonResponse(res, 409, {
              error: `A topic named "${t.topic}" already exists in ${channel}. Join it instead, or use a different name.`,
              existing: {
                id: t.id,
                topic: t.topic,
                channel: t.channel,
                creator: t.creator,
                state: t.state,
                createdAt: t.createdAt,
              },
            })
            return
          }
        }
        const id = crypto.randomUUID()
        const createdAt = new Date().toISOString()
        const localTopic: LocalTopic = {
          id,
          topic: body.topic,
          channel,
          creator: body.creator,
          state: 'active',
          createdAt,
          messages: [],
          joinedSessions: new Set(),
        }
        topics.set(id, localTopic)
        const topicData = { id, topic: body.topic, channel, creator: body.creator, state: 'active', createdAt }
        const event = { source: 'local' as const, type: 'topic_created' as const, channel, topic: topicData }
        broadcast(JSON.stringify(event))
        log(`TOPIC CREATED ${channel}: ${id} "${body.topic}" by ${body.creator}`)
        jsonResponse(res, 200, topicData)
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  if (pathname === '/topics' && method === 'GET') {
    const includeArchived = searchParams.get('include_archived') === 'true'
    const channelFilter = normalizeChannel(searchParams.get('channel'))
    const sessionFilter = searchParams.get('sessionId')

    let allowedChannels: Set<string> | null = null
    if (channelFilter) {
      allowedChannels = new Set([channelFilter])
    } else if (sessionFilter) {
      const info = sessions.get(sessionFilter)
      allowedChannels = info ? new Set(info.channels) : new Set()
    }

    const result: Array<{
      id: string
      topic: string
      channel: string
      creator: string
      state: string
      createdAt: string
      messageCount: number
    }> = []
    for (const t of topics.values()) {
      if (!includeArchived && t.state === 'archived') continue
      if (allowedChannels && !allowedChannels.has(t.channel)) continue
      result.push({
        id: t.id,
        topic: t.topic,
        channel: t.channel,
        creator: t.creator,
        state: t.state,
        createdAt: t.createdAt,
        messageCount: t.messages.length,
      })
    }
    jsonResponse(res, 200, { topics: result })
    return
  }

  const getMatch = TOPIC_ID_ROUTE.exec(pathname)
  if (getMatch && method === 'GET') {
    const id = getMatch[1]!
    const t = topics.get(id)
    if (!t) {
      jsonResponse(res, 404, { error: 'topic not found' })
      return
    }
    const sessionId = searchParams.get('sessionId')
    if (!sessionId) {
      jsonResponse(res, 400, { error: 'sessionId query parameter is required' })
      return
    }
    const info = sessions.get(sessionId)
    if (!info || !info.channels.has(t.channel)) {
      jsonResponse(res, 403, { error: `Not subscribed to channel "${t.channel}".` })
      return
    }
    jsonResponse(res, 200, {
      topic: {
        id: t.id,
        topic: t.topic,
        channel: t.channel,
        creator: t.creator,
        state: t.state,
        createdAt: t.createdAt,
      },
      messages: t.messages,
    })
    return
  }

  // Paged read-history for a topic. Unlike GET /topics/:id (which returns the
  // full message list for a subscribed session), this pages the in-memory
  // history newest-page-first via `before`/`limit` and normalizes `ts` to
  // epoch-ms so it matches the shared TransportHistoryPage contract.
  //
  // Deliberately NOT subscription-gated: the read-history transport contract
  // carries no session identity, and the broker is loopback-only and
  // single-tenant, so there is nothing to authorize against. If per-session
  // gating is ever wanted, `readTopicMessages` must first grow a `sessionName`
  // across the Transport interface (local + remote + tool layer).
  const historyMatch = TOPIC_MESSAGES_ROUTE.exec(pathname)
  if (historyMatch && method === 'GET') {
    const id = historyMatch[1]!
    const t = topics.get(id)
    if (!t) {
      jsonResponse(res, 404, { error: 'topic not found' })
      return
    }
    const limit = clampHistoryLimit(searchParams.get('limit'))
    const beforeRaw = searchParams.get('before')
    const beforeNum = beforeRaw === null ? NaN : Number(beforeRaw)
    // A malformed cursor falls back to the newest page. `before` is always
    // machine-generated (a prior page's numeric `oldestTs`), so garbage here
    // is an internal bug, not untrusted input worth a 400.
    const before = Number.isFinite(beforeNum) ? beforeNum : null
    const all = t.messages.map((m) => ({ sender: m.sender, text: m.text, ts: Date.parse(m.ts) }))
    jsonResponse(res, 200, pageTopicHistory(all, { limit, before }))
    return
  }

  const actionMatch = TOPIC_ACTION_ROUTE.exec(pathname)
  if (actionMatch && method === 'POST') {
    const id = actionMatch[1]!
    const action = actionMatch[2]!

    void (async () => {
      const t = topics.get(id)
      if (!t) {
        jsonResponse(res, 404, { error: 'topic not found' })
        return
      }

      try {
        const rawBody = await readBody(req)
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}

        switch (action) {
          case 'messages': {
            const text = body.text as string | undefined
            const sender = body.sender as string | undefined
            if (!text || !sender) {
              jsonResponse(res, 400, { error: 'text and sender are required' })
              return
            }
            const info = sessions.get(sender)
            if (!info || !info.channels.has(t.channel)) {
              jsonResponse(res, 403, { error: `Sender is not subscribed to channel "${t.channel}".` })
              return
            }
            const ts = new Date().toISOString()
            t.messages.push({ sender, text, ts })
            const event = {
              source: 'local' as const,
              type: 'message' as const,
              channel: t.channel,
              topicId: id,
              // Carried so a channel watcher, which never joined this topic and
              // so has no local name for its id, can name what it is reading.
              topicName: t.topic,
              sender,
              text,
              ts,
            }
            broadcast(JSON.stringify(event))
            log(`MESSAGE in ${id} (${t.channel}): ${sender}: ${text}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'join': {
            const sessionId = body.sessionId as string | undefined
            if (!sessionId) {
              jsonResponse(res, 400, { error: 'sessionId is required' })
              return
            }
            const info = sessions.get(sessionId)
            if (!info || !info.channels.has(t.channel)) {
              jsonResponse(res, 403, { error: `You are not subscribed to channel "${t.channel}".` })
              return
            }
            t.joinedSessions.add(sessionId)
            log(`JOIN: ${sessionId} joined topic ${id} (${t.channel})`)
            jsonResponse(res, 200, { ok: true, channel: t.channel, messages: t.messages })
            return
          }
          case 'leave': {
            const sessionId = body.sessionId as string | undefined
            if (sessionId) t.joinedSessions.delete(sessionId)
            log(`LEAVE: ${sessionId ?? 'unknown'} left topic ${id}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'archive': {
            const archivedBy = body.archivedBy as string | undefined
            t.state = 'archived'
            const event = {
              source: 'local' as const,
              type: 'topic_archived' as const,
              channel: t.channel,
              topicId: id,
              topicName: t.topic,
              archivedBy: archivedBy ?? 'unknown',
            }
            broadcast(JSON.stringify(event))
            log(`TOPIC ARCHIVED: ${id} by ${archivedBy ?? 'unknown'}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'unarchive': {
            const unarchivedBy = body.unarchivedBy as string | undefined
            t.state = 'active'
            const event = {
              source: 'local' as const,
              type: 'topic_unarchived' as const,
              channel: t.channel,
              topicId: id,
              topicName: t.topic,
              unarchivedBy: unarchivedBy ?? 'unknown',
            }
            broadcast(JSON.stringify(event))
            log(`TOPIC UNARCHIVED: ${id} by ${unarchivedBy ?? 'unknown'}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
        }
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  if (pathname === '/sessions' && method === 'GET') {
    const channelFilter = normalizeChannel(searchParams.get('channel'))
    const result: Array<{ name: string; objective?: string; registeredAt: string; channels: string[] }> = []
    for (const s of sessions.values()) {
      if (channelFilter && !s.channels.has(channelFilter)) continue
      result.push({ name: s.name, objective: s.objective, registeredAt: s.registeredAt, channels: [...s.channels] })
    }
    jsonResponse(res, 200, { sessions: result })
    return
  }

  if (pathname === '/sessions' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { name?: string; objective?: string }
        if (!body.name) {
          jsonResponse(res, 400, { error: 'name is required' })
          return
        }
        const existing = sessions.get(body.name)
        const info: SessionInfo = existing
          ? { ...existing, objective: body.objective ?? existing.objective }
          : { name: body.name, objective: body.objective, registeredAt: new Date().toISOString(), channels: new Set() }
        sessions.set(body.name, info)
        log(`SESSION REGISTERED: ${body.name}${body.objective ? ` (${body.objective})` : ''}`)
        jsonResponse(res, 200, { ok: true })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  const sessionNameMatch = SESSION_NAME_ROUTE.exec(pathname)
  if (sessionNameMatch && method === 'DELETE') {
    const name = decodeURIComponent(sessionNameMatch[1]!)
    removeSessionFromAllChannels(name)
    sessions.delete(name)
    log(`SESSION UNREGISTERED: ${name}`)
    jsonResponse(res, 200, { ok: true })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

function shutdown(): void {
  log('Shutting down...')
  for (const client of clients) {
    client.end()
  }
  clients.clear()
  server.close()
  removeRendezvous()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function main(): Promise<void> {
  writeFileSync(PID_FILE, String(process.pid))
  log(`PID ${process.pid} (profile=${PROFILE}) written to ${PID_FILE}`)

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo
    const port = addr.port
    writeFileSync(BROKER_RENDEZVOUS_FILE, JSON.stringify({ port, pid: process.pid, profile: PROFILE }))
    log(`Broker listening on http://127.0.0.1:${port} (profile=${PROFILE}, rendezvous=${BROKER_RENDEZVOUS_FILE})`)
  })
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
