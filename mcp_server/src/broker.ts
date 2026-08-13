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

interface SSEClient {
  res: SSEResponse
  /** Session this connection identified as via `/events?sessionId=`.
   *  `undefined` for a connection that named nobody. */
  sessionName?: string
}

const clients = new Set<SSEClient>()

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  appendFileSync(LOG_FILE, line)
}

/**
 * Is this connection's session subscribed to `channel` right now (KAI-446)?
 *
 * Membership is read at fan-out time rather than captured when the stream
 * opened, so a `join_channel` or `leave_channel` takes effect on a connection
 * that is already open — otherwise every join would need a reconnect.
 *
 * This is the only place a connection's `/events?sessionId=` tag is resolved
 * against the session registry. If that registry is ever keyed by something
 * other than the display name (a per-registration id, say), this lookup and the
 * tag `broker-event-listener.ts` writes have to change in the same commit —
 * they are two halves of one agreement and neither fails loudly on its own.
 */
function sseSubscribed(client: SSEClient, channel: string): boolean {
  if (!client.sessionName) return false
  // Same lookup as the route guards (KAI-446 S1) — one source of truth.
  return subscribedChannels(client.sessionName).has(channel)
}

/**
 * Fan an event out to the SSE streams entitled to it.
 *
 * `channel` scopes delivery: a channel-tagged event reaches only connections
 * whose session is subscribed to that channel. Before KAI-446, `/events`
 * handed every event to every connection and the only channel filtering lived
 * client-side in `broker-event-listener.ts`. A cooperating client filtered; a
 * hostile one read the wire. This branch also added the matching subscription
 * checks on the topic routes themselves (several of which were previously
 * ungated) — see `requireSubscribed`.
 *
 * Untagged events (no `channel`) still reach every connection. That lane stays
 * wide so a leak INTO it remains observable (product decision; do not narrow
 * here). External `/local-event` posts are the only untagged producer today.
 *
 * Like the route guards this is not authentication — see `requireSubscribed`
 * for what naming a session is actually worth. It makes the stream answer to
 * the same subscription rule the routes already answer to, nothing more.
 */
function broadcast(data: string, channel?: string): void {
  const payload = `data: ${data}\n\n`
  for (const client of clients) {
    if (channel !== undefined && !sseSubscribed(client, channel)) continue
    try {
      client.res.write(payload)
    } catch {
      clients.delete(client)
    }
  }
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
  /**
   * How many live `POST /sessions` registrations currently claim this name
   * (KAI-446 C1). Two processes that `introduce` under the same display name
   * share one registry row; without a holder count the first `DELETE
   * /sessions/:name` (ordinary shutdown) wiped memberships and permanently
   * deafened every other open SSE stream still tagged with that name.
   * Each register increments; each unregister decrements; the row is only
   * removed when the count hits zero.
   */
  holders: number
  /**
   * Per-channel join refcount for the same reason: two processes sharing a
   * name both call `join_channel`, then either may `leave_channel`. Drop
   * entitlement only when the last holder leaves the channel.
   */
  channelHolds: Map<string, number>
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

/**
 * Push an untagged diagnostic event to every SSE stream currently tagged
 * with `sessionName`. Untagged so it still arrives after channel membership
 * is gone — channel-scoped delivery would miss the very clients that just
 * lost entitlement (KAI-446 C1 observability half).
 */
function notifySession(sessionName: string, event: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const client of clients) {
    if (client.sessionName !== sessionName) continue
    try {
      client.res.write(payload)
    } catch {
      clients.delete(client)
    }
  }
}

function ensureSession(name: string): SessionInfo {
  let info = sessions.get(name)
  if (!info) {
    info = {
      name,
      registeredAt: new Date().toISOString(),
      channels: new Set(),
      holders: 0,
      channelHolds: new Map(),
    }
    sessions.set(name, info)
  }
  return info
}

function joinChannel(sessionName: string, channel: string): boolean {
  const info = ensureSession(sessionName)
  const prev = info.channelHolds.get(channel) ?? 0
  info.channelHolds.set(channel, prev + 1)
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

/**
 * Drop one hold on `channel` for `sessionName`. Entitlement (and topic
 * residue) is only removed when the hold count reaches zero — so a sibling
 * process that still holds the channel under the same display name keeps
 * receiving events (KAI-446 C1).
 */
function leaveChannel(sessionName: string, channel: string): boolean {
  const info = sessions.get(sessionName)
  if (!info) return false
  const prev = info.channelHolds.get(channel) ?? 0
  if (prev <= 0 && !info.channels.has(channel)) return false
  if (prev > 1) {
    info.channelHolds.set(channel, prev - 1)
    return false
  }
  info.channelHolds.delete(channel)
  const removed = info.channels.delete(channel)
  const members = channels.get(channel)
  if (members) {
    members.delete(sessionName)
    if (members.size === 0) channels.delete(channel)
  }
  for (const t of topics.values()) {
    if (t.channel === channel) t.joinedSessions.delete(sessionName)
  }
  if (removed) {
    // Untagged: streams tagged with this session must hear the loss even
    // though they are no longer entitled to the channel's fan-out.
    notifySession(sessionName, {
      source: 'local',
      type: 'channel_unsubscribed',
      sessionId: sessionName,
      channel,
      ts: new Date().toISOString(),
    })
  }
  return removed
}

function removeSessionFromAllChannels(sessionName: string): void {
  const info = sessions.get(sessionName)
  if (!info) return
  // Force-drop every channel regardless of hold count (full unregister).
  for (const ch of [...info.channels]) {
    info.channelHolds.set(ch, 1)
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

/**
 * The single channel-subscription rule for topic routes (KAI-446).
 *
 * Every route that reads or mutates a topic gates on it. It used to be
 * copy-pasted into some routes and simply missing from their siblings — so
 * `GET /topics/:id` 403'd an unsubscribed session while `GET /topics/:id/messages`
 * handed the same session that topic's full text. Keeping the rule in one place
 * is what stops the two drifting apart again.
 *
 * Takes the channel rather than the topic so the routes that have no topic in
 * hand can use it too: `GET /topics` gates on the requested channel, `POST
 * /topics` and `POST /broadcast` on the one being written to. Those last two
 * kept their own copy of the rule and answered 400 where the helper answers
 * 403 — cosmetic drift, but drift on the two routes the ticket exists to stop
 * drifting.
 *
 * Returns the validated session id, or null when it has already answered `res`
 * and the caller must stop. Mirrors the order `GET /topics/:id` already used —
 * topic-existence (404) is checked by the caller first, then missing id (400),
 * then subscription (403) — so an unknown topic still 404s regardless of session.
 *
 * NOTE: this is not authentication, and it buys less than it looks like it
 * does. Entitlement is a session name, and names are free: `POST /channels/join`
 * is unauthenticated and `ensureSession` creates whatever it is handed, so one
 * call mints an entitled identity for any channel. `server.ts` also auto-joins
 * under the OS username before `introduce` runs, so a session nothing
 * legitimate reads as (the listener stays anonymous until it has a name) sits
 * subscribed in every deployment, and `GET /sessions` hands out its name.
 *
 * So: this makes the routes on one resource agree on one rule, which is what
 * KAI-446 is about. It does NOT keep a determined local process out, and it
 * does not guarantee that an unauthorized read leaves a trace — borrowing an
 * existing name is quieter than joining. Only broker authentication would.
 */
/**
 * Subscription gate for routes that mutate or read topic/channel content.
 * Returns a discriminated result so callers cannot discard the gate and still
 * typecheck, and so every site uses the same (possibly normalized) sessionId
 * rather than the raw input (KAI-446 I10).
 */
type Gate = { ok: true; sessionId: string } | { ok: false }

function requireSessionId(res: ServerResponse, sessionId: string | undefined | null): sessionId is string {
  if (!sessionId) {
    jsonResponse(res, 400, { error: 'sessionId is required' })
    return false
  }
  return true
}

function requireSubscribed(res: ServerResponse, channel: string, sessionId: string | undefined | null): Gate {
  if (!requireSessionId(res, sessionId)) return { ok: false }
  if (!subscribedChannels(sessionId).has(channel)) {
    jsonResponse(res, 403, { error: `Not subscribed to channel "${channel}".` })
    return { ok: false }
  }
  return { ok: true, sessionId }
}

/** The channels this session is subscribed to; empty for an unknown session.
 *  Returns a fresh Set so callers cannot grant entitlement by mutating the
 *  live registry through a cast (KAI-446 S3). */
function subscribedChannels(sessionId: string): ReadonlySet<string> {
  return new Set(sessions.get(sessionId)?.channels)
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

    // Naming a session is what entitles the connection to that session's
    // channel-tagged events (KAI-446). A connection that names nobody stays
    // open and receives untagged events only — the listener connects before
    // `introduce` has run and re-opens with its name afterwards.
    const client: SSEClient = { res: res as SSEResponse, sessionName: searchParams.get('sessionId') ?? undefined }
    clients.add(client)
    // Push the headers now instead of waiting for the first event: SSE clients
    // (and the event listener) need a live connection immediately, before any
    // broadcast, so they don't miss events that fire right after connecting.
    res.flushHeaders()
    log(`SSE client connected as ${client.sessionName ?? 'anonymous'} (total: ${clients.size})`)

    req.on('close', () => {
      clients.delete(client)
      log(`SSE client disconnected (total: ${clients.size})`)
    })
    return
  }

  // KAI-446 I11 / I7: outside the `/topics` prefix and deliberately NOT
  // subscription-gated. Ticket AC covered topic routes; this remains an
  // unauthenticated inject-into-any-channel path. No production caller in
  // the repo (tests only). Product decision for Samuel: gate on a subscribed
  // sender, or delete the route — do not "fix" unilaterally here.
  if (pathname === '/local-event' && method === 'POST') {
    void (async () => {
      try {
        const event = JSON.parse(await readBody(req)) as Record<string, unknown>
        if (!event.type) {
          jsonResponse(res, 400, { error: 'type is required' })
          return
        }
        const payload = { source: 'local', ...event }
        // A channel-tagged event here is scoped like any other; an untagged one
        // rides the wide lane. Normalized because this body is arbitrary input,
        // unlike the broker's own events which carry an already-normalized name.
        broadcast(JSON.stringify(payload), normalizeChannel(event.channel) ?? undefined)
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

  // KAI-446 I11: not under `/topics`, yet `leaveChannel` clears
  // `t.joinedSessions` for every topic on the channel. The route-sweep only
  // covers `/topics/*`. Availability for shared names is handled by
  // `channelHolds` refcounts + `channel_unsubscribed` (C1), not by
  // `requireSubscribed` here — body carries only the subject, so "self vs
  // sibling" is indistinguishable (see broker tests + product decisions).
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
        const gate = requireSubscribed(res, channel, body.sender)
        if (!gate.ok) return
        const event = {
          source: 'local' as const,
          type: 'broadcast' as const,
          channel,
          sender: gate.sessionId,
          text: body.text,
          ts: new Date().toISOString(),
        }
        broadcast(JSON.stringify(event), channel)
        log(`BROADCAST ${channel}: ${gate.sessionId}: ${body.text}`)
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
        const gate = requireSubscribed(res, channel, body.creator)
        if (!gate.ok) return
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
          creator: gate.sessionId,
          state: 'active',
          createdAt,
          messages: [],
          joinedSessions: new Set(),
        }
        topics.set(id, localTopic)
        const topicData = {
          id,
          topic: body.topic,
          channel,
          creator: gate.sessionId,
          state: 'active',
          createdAt,
        }
        const event = { source: 'local' as const, type: 'topic_created' as const, channel, topic: topicData }
        broadcast(JSON.stringify(event), channel)
        log(`TOPIC CREATED ${channel}: ${id} "${body.topic}" by ${gate.sessionId}`)
        jsonResponse(res, 200, topicData)
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  // Listing is a topic read, so it answers to the same rule (KAI-446). It used
  // to derive the caller's channels only when no `channel` param was supplied —
  // and the local transport sends `channel` INSTEAD of `sessionId`, never both,
  // so `?channel=<foreign>` was ungated and a bare `GET /topics` enumerated
  // every topic in every channel. Metadata rather than message text, but the
  // same rule applies: you see the channels you joined.
  if (pathname === '/topics' && method === 'GET') {
    const includeArchived = searchParams.get('include_archived') === 'true'
    const channelFilter = normalizeChannel(searchParams.get('channel'))
    const sessionId = searchParams.get('sessionId')

    let allowedChannels: ReadonlySet<string>
    if (channelFilter) {
      const gate = requireSubscribed(res, channelFilter, sessionId)
      if (!gate.ok) return
      allowedChannels = new Set([channelFilter])
    } else {
      if (!requireSessionId(res, sessionId)) return
      allowedChannels = subscribedChannels(sessionId)
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
      if (!allowedChannels.has(t.channel)) continue
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
    if (!requireSubscribed(res, t.channel, searchParams.get('sessionId')).ok) return
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
  // Subscription-gated exactly like GET /topics/:id (KAI-446). This route used
  // to be ungated on the grounds that the read-history transport contract
  // carried no session identity — so `readTopicMessages` grew a `sessionName`
  // across the Transport interface (local + remote + tool layer) and the
  // asymmetry is gone: both routes on this resource now answer to the same rule.
  const historyMatch = TOPIC_MESSAGES_ROUTE.exec(pathname)
  if (historyMatch && method === 'GET') {
    const id = historyMatch[1]!
    const t = topics.get(id)
    if (!t) {
      jsonResponse(res, 404, { error: 'topic not found' })
      return
    }
    if (!requireSubscribed(res, t.channel, searchParams.get('sessionId')).ok) return
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
            const gate = requireSubscribed(res, t.channel, sender)
            if (!gate.ok) return
            const ts = new Date().toISOString()
            t.messages.push({ sender: gate.sessionId, text, ts })
            const event = {
              source: 'local' as const,
              type: 'message' as const,
              channel: t.channel,
              topicId: id,
              sender: gate.sessionId,
              text,
              ts,
            }
            broadcast(JSON.stringify(event), t.channel)
            log(`MESSAGE in ${id} (${t.channel}): ${gate.sessionId}: ${text}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'join': {
            const gate = requireSubscribed(res, t.channel, body.sessionId as string | undefined)
            if (!gate.ok) return
            t.joinedSessions.add(gate.sessionId)
            log(`JOIN: ${gate.sessionId} joined topic ${id} (${t.channel})`)
            jsonResponse(res, 200, { ok: true, channel: t.channel, messages: t.messages })
            return
          }
          case 'leave': {
            const gate = requireSubscribed(res, t.channel, body.sessionId as string | undefined)
            if (!gate.ok) return
            t.joinedSessions.delete(gate.sessionId)
            log(`LEAVE: ${gate.sessionId} left topic ${id}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'archive': {
            const gate = requireSubscribed(res, t.channel, body.archivedBy as string | undefined)
            if (!gate.ok) return
            t.state = 'archived'
            const event = {
              source: 'local' as const,
              type: 'topic_archived' as const,
              channel: t.channel,
              topicId: id,
              archivedBy: gate.sessionId,
            }
            broadcast(JSON.stringify(event), t.channel)
            log(`TOPIC ARCHIVED: ${id} by ${gate.sessionId}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'unarchive': {
            const gate = requireSubscribed(res, t.channel, body.unarchivedBy as string | undefined)
            if (!gate.ok) return
            const unarchivedBy = gate.sessionId
            t.state = 'active'
            const event = {
              source: 'local' as const,
              type: 'topic_unarchived' as const,
              channel: t.channel,
              topicId: id,
              unarchivedBy,
            }
            broadcast(JSON.stringify(event), t.channel)
            log(`TOPIC UNARCHIVED: ${id} by ${unarchivedBy}`)
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
        // Each register takes a holder slot. Two processes introducing under
        // the same display name must both hold the row so one shutdown cannot
        // wipe the other's channel memberships (KAI-446 C1).
        const existing = sessions.get(body.name)
        const info: SessionInfo = existing
          ? {
              ...existing,
              objective: body.objective ?? existing.objective,
              holders: existing.holders + 1,
            }
          : {
              name: body.name,
              objective: body.objective,
              registeredAt: new Date().toISOString(),
              channels: new Set(),
              holders: 1,
              channelHolds: new Map(),
            }
        sessions.set(body.name, info)
        log(`SESSION REGISTERED: ${body.name}${body.objective ? ` (${body.objective})` : ''} (holders=${info.holders})`)
        jsonResponse(res, 200, { ok: true })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  // KAI-446 I11: outside `/topics`, yet `removeSessionFromAllChannels` mutates
  // every topic's `joinedSessions` for this name. Same ceiling as leave —
  // the sweep cannot see it. Holder refcounts + `session_unregistered` (C1)
  // keep sibling streams alive; the path still carries no caller identity.
  const sessionNameMatch = SESSION_NAME_ROUTE.exec(pathname)
  if (sessionNameMatch && method === 'DELETE') {
    const name = decodeURIComponent(sessionNameMatch[1]!)
    const info = sessions.get(name)
    if (!info) {
      jsonResponse(res, 200, { ok: true })
      return
    }
    info.holders = Math.max(0, info.holders - 1)
    if (info.holders > 0) {
      // Sibling process still claims this name — keep memberships and streams
      // alive. The caller already stopped listening; the remaining holders
      // must not go deaf (KAI-446 C1).
      log(`SESSION UNREGISTER retained: ${name} (holders=${info.holders})`)
      jsonResponse(res, 200, { ok: true, retained: true })
      return
    }
    removeSessionFromAllChannels(name)
    sessions.delete(name)
    // Untagged notice so any still-open stream tagged with this name can
    // re-introduce / re-join instead of sitting silently deaf.
    notifySession(name, {
      source: 'local',
      type: 'session_unregistered',
      sessionId: name,
      ts: new Date().toISOString(),
    })
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
    client.res.end()
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
