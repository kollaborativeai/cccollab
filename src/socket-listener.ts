// NOTE: This file is named `socket-listener.ts` for legacy reasons (the original
// version bridged Slack Socket Mode events). It now only consumes local broker
// events over SSE. A rename (e.g. to `broker-event-listener.ts`) is pending a
// follow-up cleanup pass in CCC-26.
import http from 'node:http'
import { appendFileSync } from 'node:fs'
import type { MessageBus } from './message-bus.js'
import type { ActiveContext } from './context.js'
import type { SessionManager } from './session.js'
import type { ParsedMessage } from './types.js'

const LOG_FILE = '/tmp/cccollab-debug.log'
const RECONNECT_DELAY_MS = 2000

interface SocketModeListenerOptions {
  brokerUrl: string
  messageBus: MessageBus
  sessionManager: SessionManager
  context: ActiveContext
}

export interface BrokerLocalEvent {
  source: 'local'
  type: 'message' | 'topic_created' | 'topic_archived' | 'topic_unarchived' | 'broadcast' | 'direct_message'
  topicId?: string
  topic?: { id: string; topic: string; creator: string; state?: string; createdAt?: string }
  sender?: string
  from?: string
  to?: string
  text?: string
  archivedBy?: string
  ts?: string
}

function isLocalEvent(data: unknown): data is BrokerLocalEvent {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>).source === 'local'
}

export class SocketModeListener {
  private readonly brokerUrl: string
  private readonly bus: MessageBus
  private readonly session: SessionManager
  private readonly context: ActiveContext
  private currentRequest: http.ClientRequest | null = null
  private stopped = false

  constructor(options: SocketModeListenerOptions) {
    this.brokerUrl = options.brokerUrl
    this.bus = options.messageBus
    this.session = options.sessionManager
    this.context = options.context
  }

  async start(): Promise<void> {
    this.stopped = false
    this.connect()
    this.log('SSE listener started')
  }

  stop(): void {
    this.stopped = true
    if (this.currentRequest) {
      this.currentRequest.destroy()
      this.currentRequest = null
    }
  }

  private connect(): void {
    if (this.stopped) return

    const url = `${this.brokerUrl}/events`
    this.log(`Connecting to broker at ${url}`)

    const req = http.get(url, { headers: { 'Accept': 'text/event-stream' } }, (res) => {
      let buffer = ''

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const json = line.slice(6)
            try {
              const parsed = JSON.parse(json) as Record<string, unknown>
              if (isLocalEvent(parsed)) {
                this.processLocalEvent(parsed)
              } else {
                this.log(`DROPPED: non-local event ignored: ${json.slice(0, 120)}`)
              }
            } catch {
              this.log(`SSE parse error: ${json}`)
            }
          }
        }
      })

      res.on('end', () => {
        this.log('SSE connection ended')
        this.scheduleReconnect()
      })

      res.on('error', (err) => {
        this.log(`SSE response error: ${err.message}`)
        this.scheduleReconnect()
      })
    })

    req.on('error', (err) => {
      this.log(`SSE request error: ${err.message}`)
      this.scheduleReconnect()
    })

    this.currentRequest = req
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.log(`Reconnecting in ${RECONNECT_DELAY_MS}ms...`)
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS)
  }

  processLocalEvent(event: BrokerLocalEvent): void {
    this.log(`LOCAL EVENT: type=${event.type} topicId=${event.topicId ?? 'none'} sender=${event.sender ?? 'none'}`)
    this.handleLocalEvent(event).catch((err) => {
      this.log(`LOCAL HANDLE ERROR: ${err}`)
    })
  }

  private log(msg: string): void {
    const who = this.session.hasName() ? this.session.displayName : `pid${process.pid}`
    const line = `[${new Date().toISOString()}] [${who}] ${msg}\n`
    appendFileSync(LOG_FILE, line)
  }

  private async handleLocalEvent(event: BrokerLocalEvent): Promise<void> {
    switch (event.type) {
      case 'topic_created': {
        // Push topic creation to other sessions (skip the creator)
        if (!event.topic) {
          this.log(`DROPPED: topic_created with no topic field`)
          return
        }
        if (event.topic.creator && this.session.isExactSelf(event.topic.creator)) {
          this.log(`DROPPED: self topic_created from ${event.topic.creator}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.topic.creator,
          text: `New local topic: "${event.topic.topic}"`,
          ts: event.topic.createdAt ?? new Date().toISOString(),
          channel: 'local',
          channelName: 'local',
          threadTs: undefined,
        }
        this.log(`PUSHING local topic_created to Claude: "${event.topic.topic}"`)
        await this.bus.push(msg)
        return
      }
      case 'message': {
        // Only push if this session has joined the topic
        if (!event.topicId || !this.context.isTopicJoined(event.topicId)) {
          this.log(`DROPPED local message: topic ${event.topicId ?? 'none'} not joined`)
          return
        }
        // Skip self-messages (strict match on chosen name, not username fallback)
        if (event.sender && this.session.isExactSelf(event.sender)) {
          this.log(`DROPPED: self local message from ${event.sender}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.sender ?? 'unknown',
          text: event.text ?? '',
          ts: event.ts ?? new Date().toISOString(),
          channel: 'local',
          channelName: 'local',
          threadTs: event.topicId,
        }
        this.log(`PUSHING local message to Claude: sender=${msg.sender} text="${msg.text.slice(0, 80)}"`)
        await this.bus.push(msg)
        return
      }
      case 'topic_archived': {
        if (!event.topicId || !this.context.isTopicJoined(event.topicId)) {
          this.log(`DROPPED local topic_archived: topic ${event.topicId ?? 'none'} not joined`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.archivedBy ?? 'unknown',
          text: 'Topic archived',
          ts: new Date().toISOString(),
          channel: 'local',
          channelName: 'local',
          threadTs: event.topicId,
        }
        this.log(`PUSHING local topic_archived to Claude`)
        await this.bus.push(msg)
        return
      }
      case 'topic_unarchived': {
        if (!event.topicId || !this.context.isTopicJoined(event.topicId)) {
          this.log(`DROPPED local topic_unarchived: topic ${event.topicId ?? 'none'} not joined`)
          return
        }
        const msg: ParsedMessage = {
          sender: 'system',
          text: 'Topic unarchived',
          ts: new Date().toISOString(),
          channel: 'local',
          channelName: 'local',
          threadTs: event.topicId,
        }
        this.log(`PUSHING local topic_unarchived to Claude`)
        await this.bus.push(msg)
        return
      }
      case 'broadcast': {
        // Skip self-messages (strict match on chosen name, not username fallback)
        if (event.sender && this.session.isExactSelf(event.sender)) {
          this.log(`DROPPED: self local broadcast from ${event.sender}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.sender ?? 'unknown',
          text: event.text ?? '',
          ts: event.ts ?? new Date().toISOString(),
          channel: 'local',
          channelName: 'local',
          threadTs: undefined,
        }
        this.log(`PUSHING local broadcast to Claude: sender=${msg.sender} text="${msg.text.slice(0, 80)}"`)
        await this.bus.push(msg)
        return
      }
      case 'direct_message': {
        // Only deliver if this session is the intended recipient
        if (!event.to || !this.session.isExactSelf(event.to)) {
          this.log(`DROPPED direct_message: not for us (to=${event.to ?? 'none'})`)
          return
        }
        if (event.from && this.session.isExactSelf(event.from)) return
        const msg: ParsedMessage = {
          sender: event.from ?? 'unknown',
          text: `Direct message from ${event.from ?? 'unknown'}: ${event.text ?? ''}`,
          ts: new Date().toISOString(),
          channel: 'local',
          channelName: 'local',
          threadTs: undefined,
        }
        this.log(`PUSHING direct_message to Claude: from=${event.from ?? 'unknown'}`)
        await this.bus.push(msg)
        return
      }
    }
  }
}
