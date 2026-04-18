#!/usr/bin/env npx tsx
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync, appendFileSync } from 'node:fs'
import crypto from 'node:crypto'
import { SocketModeClient } from '@slack/socket-mode'
import { BROKER_ID, BROKER_RENDEZVOUS_FILE } from './constants.js'
import { removeRendezvous } from './broker-discovery.js'

const PID_FILE = `/tmp/slack-collab-broker-${BROKER_ID}.pid`
const LOG_FILE = `/tmp/slack-collab-broker-${BROKER_ID}.log`

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

// --- Local topic storage ---

interface LocalTopicMessage {
  sender: string
  text: string
  ts: string
}

interface LocalTopic {
  id: string
  topic: string
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
}

const topics = new Map<string, LocalTopic>()
const sessions = new Map<string, SessionInfo>()

const MAX_BODY_SIZE = 1024 * 1024 // 1MB

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

// --- Slack Socket Mode ---

const appToken = process.env.SLACK_APP_TOKEN
if (!appToken) {
  log('FATAL: SLACK_APP_TOKEN is required')
  process.exit(1)
}

const socketClient = new SocketModeClient({ appToken })

socketClient.on('message', ({ event, ack }) => {
  // Ack immediately
  void Promise.resolve(ack())

  if (!event || event.type !== 'message') return

  const data = JSON.stringify({
    channel: event.channel as string,
    user: (event.user as string | undefined) ?? null,
    text: (event.text as string | undefined) ?? null,
    ts: event.ts as string,
    thread_ts: (event.thread_ts as string | undefined) ?? null,
    subtype: (event.subtype as string | undefined) ?? null,
  })

  log(`BROADCAST: ${data}`)
  broadcast(data)
})

// --- Route matching helpers ---

const TOPIC_ID_ROUTE = /^\/topics\/([^/]+)$/
const TOPIC_ACTION_ROUTE = /^\/topics\/([^/]+)\/(messages|join|leave|archive|unarchive)$/
const SESSION_NAME_ROUTE = /^\/sessions\/([^/]+)$/

// --- HTTP server ---

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const { pathname, searchParams } = parseUrl(req.url ?? '/')
  const method = req.method ?? 'GET'

  // Health
  if (pathname === '/health' && method === 'GET') {
    jsonResponse(res, 200, { ok: true, connections: clients.size })
    return
  }

  // SSE events stream
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

  // POST /local-event - broadcast a pre-formed local event (ping, pong, direct_message, etc.)
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

  // POST /broadcast - broadcast a local message (not in a topic)
  if (pathname === '/broadcast' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { text?: string; sender?: string }
        if (!body.text || !body.sender) {
          jsonResponse(res, 400, { error: 'text and sender are required' })
          return
        }
        const event = {
          source: 'local' as const,
          type: 'broadcast' as const,
          sender: body.sender,
          text: body.text,
          ts: new Date().toISOString(),
        }
        broadcast(JSON.stringify(event))
        log(`LOCAL BROADCAST: ${body.sender}: ${body.text}`)
        jsonResponse(res, 200, { ok: true })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  // POST /topics - create a topic
  if (pathname === '/topics' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { topic?: string; creator?: string }
        if (!body.topic || !body.creator) {
          jsonResponse(res, 400, { error: 'topic and creator are required' })
          return
        }
        const id = crypto.randomUUID()
        const createdAt = new Date().toISOString()
        const localTopic: LocalTopic = {
          id,
          topic: body.topic,
          creator: body.creator,
          state: 'active',
          createdAt,
          messages: [],
          joinedSessions: new Set(),
        }
        topics.set(id, localTopic)
        const topicData = { id, topic: body.topic, creator: body.creator, state: 'active', createdAt }
        const event = { source: 'local' as const, type: 'topic_created' as const, topic: topicData }
        broadcast(JSON.stringify(event))
        log(`LOCAL TOPIC CREATED: ${id} "${body.topic}" by ${body.creator}`)
        jsonResponse(res, 200, topicData)
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  // GET /topics - list topics
  if (pathname === '/topics' && method === 'GET') {
    const includeArchived = searchParams.get('include_archived') === 'true'
    const result: Array<{ id: string; topic: string; creator: string; state: string; createdAt: string; messageCount: number }> = []
    for (const t of topics.values()) {
      if (!includeArchived && t.state === 'archived') continue
      result.push({ id: t.id, topic: t.topic, creator: t.creator, state: t.state, createdAt: t.createdAt, messageCount: t.messages.length })
    }
    jsonResponse(res, 200, { topics: result })
    return
  }

  // GET /topics/:id - get topic with messages
  const getMatch = TOPIC_ID_ROUTE.exec(pathname)
  if (getMatch && method === 'GET') {
    const id = getMatch[1]!
    const t = topics.get(id)
    if (!t) {
      jsonResponse(res, 404, { error: 'topic not found' })
      return
    }
    jsonResponse(res, 200, {
      topic: { id: t.id, topic: t.topic, creator: t.creator, state: t.state, createdAt: t.createdAt },
      messages: t.messages,
    })
    return
  }

  // Topic action routes: POST /topics/:id/(messages|join|resolve|deactivate|activate)
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
            const ts = new Date().toISOString()
            t.messages.push({ sender, text, ts })
            const event = {
              source: 'local' as const,
              type: 'message' as const,
              topicId: id,
              sender,
              text,
              ts,
            }
            broadcast(JSON.stringify(event))
            log(`LOCAL MESSAGE in ${id}: ${sender}: ${text}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'join': {
            const sessionId = body.sessionId as string | undefined
            if (!sessionId) {
              jsonResponse(res, 400, { error: 'sessionId is required' })
              return
            }
            t.joinedSessions.add(sessionId)
            log(`LOCAL JOIN: session ${sessionId} joined topic ${id}`)
            jsonResponse(res, 200, { ok: true, messages: t.messages })
            return
          }
          case 'leave': {
            const sessionId = body.sessionId as string | undefined
            if (sessionId) t.joinedSessions.delete(sessionId)
            log(`LOCAL LEAVE: session ${sessionId ?? 'unknown'} left topic ${id}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'archive': {
            const archivedBy = body.archivedBy as string | undefined
            t.state = 'archived'
            const event = {
              source: 'local' as const,
              type: 'topic_archived' as const,
              topicId: id,
              archivedBy: archivedBy ?? 'unknown',
            }
            broadcast(JSON.stringify(event))
            log(`LOCAL TOPIC ARCHIVED: ${id} by ${archivedBy ?? 'unknown'}`)
            jsonResponse(res, 200, { ok: true })
            return
          }
          case 'unarchive': {
            t.state = 'active'
            const event = {
              source: 'local' as const,
              type: 'topic_unarchived' as const,
              topicId: id,
            }
            broadcast(JSON.stringify(event))
            log(`LOCAL TOPIC UNARCHIVED: ${id}`)
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

  // GET /sessions - list registered sessions
  if (pathname === '/sessions' && method === 'GET') {
    const result = [...sessions.values()]
    jsonResponse(res, 200, { sessions: result })
    return
  }

  // POST /sessions - register a session
  if (pathname === '/sessions' && method === 'POST') {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req)) as { name?: string; objective?: string }
        if (!body.name) {
          jsonResponse(res, 400, { error: 'name is required' })
          return
        }
        sessions.set(body.name, { name: body.name, objective: body.objective, registeredAt: new Date().toISOString() })
        log(`SESSION REGISTERED: ${body.name}${body.objective ? ` (${body.objective})` : ''}`)
        jsonResponse(res, 200, { ok: true })
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' })
      }
    })()
    return
  }

  // DELETE /sessions/:name - unregister a session
  const sessionNameMatch = SESSION_NAME_ROUTE.exec(pathname)
  if (sessionNameMatch && method === 'DELETE') {
    const name = decodeURIComponent(sessionNameMatch[1]!)
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

  await socketClient.start()
  log('Socket Mode connected')

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
