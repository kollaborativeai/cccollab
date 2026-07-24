#!/usr/bin/env npx tsx
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { PROFILE, BROKER_RENDEZVOUS_FILE, CCCOLLAB_RUN_DIR, CCCOLLAB_LOGS_DIR } from './constants.js'
import { removeRendezvous } from './broker-discovery.js'
import { clampHistoryLimit, pageTopicHistory } from './history-paging.js'

mkdirSync(CCCOLLAB_RUN_DIR, { recursive: true })
mkdirSync(CCCOLLAB_LOGS_DIR, { recursive: true })

const PID_FILE = join(CCCOLLAB_RUN_DIR, `${PROFILE}.pid`)
const LOG_FILE = join(CCCOLLAB_LOGS_DIR, `${PROFILE}.log`)

type SSEResponse = ServerResponse & { req: IncomingMessage }

const clients = new Set<SSEResponse>()

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  appendFileSync(LOG_FILE, line)
}

function broadcast(data: string): void {
  const payload = `data: ${data}\n\n`
  for (const client of clients) {
    try {
      client.write(payload)
    } catch {
      clients.delete(client)
    }
  }
}

/**
 * Write an event to only the SSE connection(s) tagged with the given
 * session name - never the global `clients` set. A DM is private (KAI-514
 * AC6): fanning it through `broadcast()` would hand its text to every
 * other connected session's event listener, even though each listener
 * currently self-filters what it surfaces to its own Claude session.
 *
 * Returns whether at least one connection received the write, which also
 * doubles as the "recipient attached at commit time" signal (AC3).
 */
function sendToSessionConnections(sessionName: string, event: unknown): boolean {
  const conns = sseBySession.get(sessionName)
  if (!conns || conns.size === 0) return false
  const payload = `data: ${JSON.stringify(event)}\n\n`
  let wrote = false
  for (const conn of conns) {
    try {
      conn.write(payload)
      wrote = true
    } catch {
      conns.delete(conn)
    }
  }
  return wrote
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
  /** Stable id for this *registration*. Reused across repeated `introduce`
   *  calls while the session stays registered; a fresh id is minted only
   *  when a new SessionInfo is created (first introduce, or introduce
   *  after a prior deregister). Never derived from `name` - two
   *  registrations sharing a display name still get distinct ids. */
  id: string
  objective?: string
  registeredAt: string
  channels: Set<string>
}

interface DmMessage {
  fromId: string
  fromName: string
  toId: string
  text: string
  ts: string
}

const topics = new Map<string, LocalTopic>()
const sessions = new Map<string, SessionInfo>()
const channels = new Map<string, Set<string>>()

/** SSE connections tagged with the session name that opened them (via
 *  `/events?sessionId=`), used only to answer "is this session currently
 *  attached" for DM delivery honesty. Distinct from the untargeted
 *  `clients` set that channel/topic broadcasts fan out to. */
const sseBySession = new Map<string, Set<SSEResponse>>()

/** Private 1:1 message threads, keyed by the two participants' sorted
 *  stable ids joined with `|`. Deliberately separate from `topics` /
 *  channel broadcasts (KAI-514 AC6): a DM must never surface in channel
 *  or topic history. */
const dmThreads = new Map<string, DmMessage[]>()

function dmPairKey(idA: string, idB: string): string {
  return [idA, idB].sort().join('|')
}

function findSessionById(id: string): SessionInfo | undefined {
  for (const info of sessions.values()) {
    if (info.id === id) return info
  }
  return undefined
}

/** Normalize channel name: trim + lowercase. Returns null if empty. */
function normalizeChannel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

function ensureSession(name: string): SessionInfo {
  let info = sessions.get(name)
  if (!info) {
    info = { name, id: crypto.randomUUID(), registeredAt: new Date().toISOString(), channels: new Set() }
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
const SESSION_DM_ROUTE = /^\/sessions\/([^/]+)\/dm$/

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
    clients.add(sseRes)
    // Optional session tag: lets DM delivery know this session is
    // currently attached (KAI-514). Untagged connections (sessionId
    // omitted) still receive channel/topic broadcasts as before.
    const sessionId = searchParams.get('sessionId') ?? undefined
    if (sessionId) {
      let conns = sseBySession.get(sessionId)
      if (!conns) {
        conns = new Set()
        sseBySession.set(sessionId, conns)
      }
      conns.add(sseRes)
    }
    // Push the headers now instead of waiting for the first event: SSE clients
    // (and the event listener) need a live connection immediately, before any
    // broadcast, so they don't miss events that fire right after connecting.
    res.flushHeaders()
    log(`SSE client connected (total: ${clients.size})`)

    req.on('close', () => {
      clients.delete(sseRes)
      if (sessionId) {
        const conns = sseBySession.get(sessionId)
        if (conns) {
          conns.delete(sseRes)
          if (conns.size === 0) sseBySession.delete(sessionId)
        }
      }
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
    const result: Array<{ name: string; id: string; objective?: string; registeredAt: string; channels: string[] }> = []
    for (const s of sessions.values()) {
      if (channelFilter && !s.channels.has(channelFilter)) continue
      result.push({
        name: s.name,
        id: s.id,
        objective: s.objective,
        registeredAt: s.registeredAt,
        channels: [...s.channels],
      })
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
          : {
              name: body.name,
              id: crypto.randomUUID(),
              objective: body.objective,
              registeredAt: new Date().toISOString(),
              channels: new Set(),
            }
        sessions.set(body.name, info)
        log(`SESSION REGISTERED: ${body.name}${body.objective ? ` (${body.objective})` : ''}`)
        jsonResponse(res, 200, { ok: true, id: info.id })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  const sessionDmMatch = SESSION_DM_ROUTE.exec(pathname)
  if (sessionDmMatch && method === 'POST') {
    const toId = decodeURIComponent(sessionDmMatch[1]!)
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { from?: string; text?: string }
        if (!body.from || !body.text) {
          jsonResponse(res, 400, { error: 'from and text are required' })
          return
        }
        const sender = sessions.get(body.from)
        if (!sender) {
          jsonResponse(res, 400, { error: `Unknown sender session "${body.from}".` })
          return
        }
        // AC2: an unknown/stale id is a normal outcome, never a name
        // fallback - report it the same way as "recipient not attached"
        // rather than a 4xx, so callers get one honest result shape.
        const recipient = findSessionById(toId)
        if (!recipient) {
          jsonResponse(res, 200, { delivered: false, reason: `Unknown recipient id "${toId}".` })
          return
        }
        if (recipient.id === sender.id) {
          jsonResponse(res, 400, { error: 'Cannot send a message to yourself.' })
          return
        }

        const ts = new Date().toISOString()
        const msg: DmMessage = { fromId: sender.id, fromName: sender.name, toId: recipient.id, text: body.text, ts }
        const pairKey = dmPairKey(sender.id, recipient.id)
        const thread = dmThreads.get(pairKey) ?? []
        thread.push(msg)
        dmThreads.set(pairKey, thread)

        const delivered = sendToSessionConnections(recipient.name, {
          source: 'local' as const,
          type: 'dm' as const,
          fromId: sender.id,
          fromName: sender.name,
          toId: recipient.id,
          text: body.text,
          ts,
        })
        log(`DM ${sender.name} -> ${recipient.name}: ${body.text}${delivered ? '' : ' (recipient not attached)'}`)
        jsonResponse(res, 200, delivered ? { delivered: true } : { delivered: false, reason: 'recipient not attached' })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  if (sessionDmMatch && method === 'GET') {
    const withId = decodeURIComponent(sessionDmMatch[1]!)
    const asName = searchParams.get('asName')
    if (!asName) {
      jsonResponse(res, 400, { error: 'asName query parameter is required' })
      return
    }
    const self = sessions.get(asName)
    if (!self) {
      jsonResponse(res, 400, { error: `Unknown session "${asName}".` })
      return
    }
    const thread = dmThreads.get(dmPairKey(self.id, withId)) ?? []
    jsonResponse(res, 200, {
      messages: thread.map((m) => ({ fromId: m.fromId, fromName: m.fromName, text: m.text, ts: m.ts })),
    })
    return
  }

  const sessionNameMatch = SESSION_NAME_ROUTE.exec(pathname)
  if (sessionNameMatch && method === 'DELETE') {
    const name = decodeURIComponent(sessionNameMatch[1]!)
    removeSessionFromAllChannels(name)
    sessions.delete(name)
    // DM delivery tags SSE connections by session name; drop this name's
    // tag on deregister so a later registration reusing the same display
    // name (a fresh id, per AC2) can't have its private DMs fan out to
    // this now-departed session's still-closing connection (KAI-514 AC6).
    // Channel/topic broadcasts are unaffected - they use the global
    // `clients` set, which the connection's own close handler prunes.
    sseBySession.delete(name)
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
