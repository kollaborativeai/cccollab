#!/usr/bin/env npx tsx
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFileSync, appendFileSync } from 'node:fs'
import { SocketModeClient } from '@slack/socket-mode'

const PORT = 7850
const PID_FILE = '/tmp/slack-collab-broker.pid'
const LOG_FILE = '/tmp/slack-collab-broker.log'

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

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, connections: clients.size }))
    return
  }

  if (req.url === '/events' && req.method === 'GET') {
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
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function main(): Promise<void> {
  writeFileSync(PID_FILE, String(process.pid))
  log(`PID ${process.pid} written to ${PID_FILE}`)

  await socketClient.start()
  log('Socket Mode connected')

  server.listen(PORT, '127.0.0.1', () => {
    log(`Broker listening on http://127.0.0.1:${PORT}`)
  })
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
