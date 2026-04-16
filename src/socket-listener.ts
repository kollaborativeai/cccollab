import http from 'node:http'
import { appendFileSync } from 'node:fs'
import type { WebClient } from '@slack/web-api'
import type { MessageBus } from './message-bus.js'
import type { SubscriptionManager } from './subscriptions.js'
import type { ActiveContext } from './context.js'
import { SessionManager } from './session.js'
import type { ParsedMessage } from './types.js'

const LOG_FILE = '/tmp/slack-collab-debug.log'
const RECONNECT_DELAY_MS = 2000

interface SocketModeListenerOptions {
  brokerUrl: string
  messageBus: MessageBus
  subscriptionManager: SubscriptionManager
  sessionManager: SessionManager
  context: ActiveContext
  botUserId: string
  selfUserId: string
  webClient: WebClient
}

export interface BrokerEvent {
  channel: string
  user: string | null
  text: string | null
  ts: string
  thread_ts: string | null
  subtype: string | null
}

const IGNORED_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'channel_archive', 'channel_unarchive',
  'bot_message', 'me_message', 'message_changed', 'message_deleted', 'thread_broadcast',
])

export class SocketModeListener {
  private readonly brokerUrl: string
  private readonly bus: MessageBus
  private readonly subs: SubscriptionManager
  private readonly session: SessionManager
  private readonly context: ActiveContext
  private readonly botUserId: string
  private readonly selfUserId: string
  private readonly webClient: WebClient
  private readonly userNameCache = new Map<string, string>()
  private currentRequest: http.ClientRequest | null = null
  private stopped = false

  constructor(options: SocketModeListenerOptions) {
    this.brokerUrl = options.brokerUrl
    this.bus = options.messageBus
    this.subs = options.subscriptionManager
    this.session = options.sessionManager
    this.context = options.context
    this.botUserId = options.botUserId
    this.selfUserId = options.selfUserId
    this.webClient = options.webClient
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
              const event = JSON.parse(json) as BrokerEvent
              this.processEvent(event)
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

  processEvent(event: BrokerEvent): void {
    this.log(`EVENT: channel=${event.channel} user=${event.user} subtype=${event.subtype} text="${(event.text ?? '').slice(0, 80)}"`)
    this.handleEvent(event).catch((err) => {
      this.log(`HANDLE ERROR: ${err}`)
    })
  }

  private log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    appendFileSync(LOG_FILE, line)
  }

  private async handleEvent(event: BrokerEvent): Promise<void> {
    if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)) {
      this.log(`DROPPED: subtype=${event.subtype}`)
      return
    }
    if (!this.subs.isSubscribed(event.channel)) {
      this.log(`DROPPED: channel ${event.channel} not subscribed`)
      return
    }

    // Thread-level filtering: only receive messages from topics we've joined
    // Top-level messages (no thread_ts) always come through (broadcasts, new topics)
    if (event.thread_ts && !this.context.isTopicJoined(event.thread_ts)) {
      this.log(`DROPPED: thread ${event.thread_ts} not joined`)
      return
    }

    const text = event.text ?? ''
    const parsed = SessionManager.parse(text)
    const isFromSelf = event.user === this.botUserId || event.user === this.selfUserId

    let sender: string
    let messageText: string

    if (parsed) {
      // Session-prefixed message (from any Claude Code session)
      if (this.session.isSelf(parsed.sender)) {
        this.log(`DROPPED: self-message from ${parsed.sender}`)
        return
      }
      this.log(`ROUTING: session message from ${parsed.sender}`)
      sender = parsed.sender
      messageText = parsed.text
    } else if (isFromSelf) {
      // System message from bot or own user token (topic headers, etc.) - skip
      this.log(`DROPPED: bot system message`)
      return
    } else {
      // Human message
      const userId = event.user ?? 'unknown'
      const displayName = await this.resolveUserName(userId)
      sender = `human:${displayName}`
      messageText = text
    }

    const channelName = this.subs.getChannelName(event.channel)

    const msg: ParsedMessage = {
      sender, text: messageText, ts: event.ts, channel: event.channel,
      channelName,
      threadTs: event.thread_ts ?? undefined,
    }

    this.log(`PUSHING to Claude: sender=${msg.sender} text="${msg.text.slice(0, 80)}"`)
    this.bus.push(msg).catch((err) => {
      this.log(`PUSH ERROR: ${err}`)
    })
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId)
    if (cached) return cached
    try {
      const result = await this.webClient.users.info({ user: userId })
      const name = result.user?.real_name ?? result.user?.name ?? userId
      this.userNameCache.set(userId, name)
      return name
    } catch {
      return userId
    }
  }
}
