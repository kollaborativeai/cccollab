#!/usr/bin/env npx tsx
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync, appendFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { BROKER_ID, BROKER_RENDEZVOUS_FILE } from './constants.js'
import { removeRendezvous } from './broker-discovery.js'

const PID_FILE = `/tmp/cccollab-broker-${BROKER_ID}.pid`
const LOG_FILE = `/tmp/cccollab-broker-${BROKER_ID}.log`

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
      'Connection': 'keep-alive',
    })

    const sseRes = res as SSEResponse
    clients.add(sseRes)
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
    if (sessionId) {
      const info = sessions.get(sessionId)
      const result: Array<{ name: string; subscriberCount: number }> = []
      if (info) {
        for (const ch of info.channels) {
          result.push({ name: ch, subscriberCount: channels.get(ch)?.size ?? 0 })
        }
      }
      jsonResponse(res, 200, { channels: result })
      return
    }
    const result: Array<{ name: string; subscriberCount: number }> = []
    for (const [name, members] of channels) {
      result.push({ name, subscriberCount: members.size })
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
        log(`CHANNEL JOIN: ${sessionId} -> #${channel}${added ? '' : ' (already)'}`)
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
        log(`CHANNEL LEAVE: ${sessionId} <- #${channel}`)
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
        log(`BROADCAST #${channel}: ${body.sender}: ${body.text}`)
        jsonResponse(res, 200, { ok: true })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  if (pathname === '/direct-message' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { from?: string; to?: string; text?: string }
        if (!body.from || !body.to || !body.text) {
          jsonResponse(res, 400, { error: 'from, to, text are required' })
          return
        }
        const fromInfo = sessions.get(body.from)
        const toInfo = sessions.get(body.to)
        if (!fromInfo) {
          jsonResponse(res, 400, { error: `Sender "${body.from}" is not registered.` })
          return
        }
        if (!toInfo) {
          jsonResponse(res, 404, { error: `No session named "${body.to}" is registered.` })
          return
        }
        let shared: string | null = null
        for (const ch of fromInfo.channels) {
          if (toInfo.channels.has(ch)) { shared = ch; break }
        }
        if (!shared) {
          jsonResponse(res, 403, {
            error: `You and "${body.to}" do not share any subscribed channel. Join a common channel first.`,
          })
          return
        }
        const event = {
          source: 'local' as const,
          type: 'direct_message' as const,
          from: body.from,
          to: body.to,
          text: body.text,
          ts: new Date().toISOString(),
        }
        broadcast(JSON.stringify(event))
        log(`DM: ${body.from} -> ${body.to} via #${shared}`)
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
              error: `A topic named "${t.topic}" already exists in #${channel}. Join it instead, or use a different name.`,
              existing: { id: t.id, topic: t.topic, channel: t.channel, creator: t.creator, state: t.state, createdAt: t.createdAt },
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
        log(`TOPIC CREATED #${channel}: ${id} "${body.topic}" by ${body.creator}`)
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

    const result: Array<{ id: string; topic: string; channel: string; creator: string; state: string; createdAt: string; messageCount: number }> = []
    for (const t of topics.values()) {
      if (!includeArchived && t.state === 'archived') continue
      if (allowedChannels && !allowedChannels.has(t.channel)) continue
      result.push({ id: t.id, topic: t.topic, channel: t.channel, creator: t.creator, state: t.state, createdAt: t.createdAt, messageCount: t.messages.length })
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
    jsonResponse(res, 200, {
      topic: { id: t.id, topic: t.topic, channel: t.channel, creator: t.creator, state: t.state, createdAt: t.createdAt },
      messages: t.messages,
    })
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
        const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {}

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
            log(`MESSAGE in ${id} (#${t.channel}): ${sender}: ${text}`)
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
            log(`JOIN: ${sessionId} joined topic ${id} (#${t.channel})`)
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
            t.state = 'active'
            const event = {
              source: 'local' as const,
              type: 'topic_unarchived' as const,
              channel: t.channel,
              topicId: id,
            }
            broadcast(JSON.stringify(event))
            log(`TOPIC UNARCHIVED: ${id}`)
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
  log(`PID ${process.pid} (id=${BROKER_ID}) written to ${PID_FILE}`)

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as AddressInfo
    const port = addr.port
    writeFileSync(BROKER_RENDEZVOUS_FILE, JSON.stringify({ port, pid: process.pid, id: BROKER_ID }))
    log(`Broker listening on http://127.0.0.1:${port} (id=${BROKER_ID}, rendezvous=${BROKER_RENDEZVOUS_FILE})`)
  })
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
