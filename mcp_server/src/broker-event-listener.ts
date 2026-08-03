import http from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageBus } from './message-bus.js'
import type { ActiveContext } from './context.js'
import type { SessionManager } from './session.js'
import type { ParsedMessage } from './types.js'
import { normalizeChannelName } from './context.js'
import { CCCOLLAB_LOGS_DIR } from './constants.js'

mkdirSync(CCCOLLAB_LOGS_DIR, { recursive: true })
const LOG_FILE = join(CCCOLLAB_LOGS_DIR, 'debug.log')
const RECONNECT_DELAY_MS = 2000

interface BrokerEventListenerOptions {
  brokerUrl: string
  messageBus: MessageBus
  sessionManager: SessionManager
  context: ActiveContext
}

export interface BrokerLocalEvent {
  source: 'local'
  type: 'message' | 'topic_created' | 'topic_archived' | 'topic_unarchived' | 'broadcast'
  channel?: string
  topicId?: string
  topic?: { id: string; topic: string; channel?: string; creator: string; state?: string; createdAt?: string }
  sender?: string
  text?: string
  archivedBy?: string
  unarchivedBy?: string
  ts?: string
}

function isLocalEvent(data: unknown): data is BrokerLocalEvent {
  return typeof data === 'object' && data !== null && (data as Record<string, unknown>).source === 'local'
}

export class BrokerEventListener {
  private readonly brokerUrl: string
  private readonly bus: MessageBus
  private readonly session: SessionManager
  private readonly context: ActiveContext
  private currentRequest: http.ClientRequest | null = null
  private stopped = false

  constructor(options: BrokerEventListenerOptions) {
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

  /**
   * Re-open the stream so it carries the session's name.
   *
   * The listener starts before `introduce` may have run, and the broker only
   * streams a channel-tagged event to a connection whose session is subscribed
   * to that channel (KAI-446). An anonymous connection therefore receives
   * nothing channel-tagged, so a session that names itself later has to
   * re-identify or it goes quiet for the rest of its life. No-op until there
   * is a name to offer.
   */
  reconnectForIdentity(): void {
    if (this.stopped || !this.session.hasName()) return
    const superseded = this.currentRequest
    this.currentRequest = null
    if (superseded) superseded.destroy()
    this.connect()
  }

  private connect(): void {
    if (this.stopped) return

    // Identify the stream: without a name the broker treats this connection as
    // anonymous and withholds every channel-tagged event (KAI-446).
    const qs = this.session.hasName() ? `?sessionId=${encodeURIComponent(this.session.displayName)}` : ''
    const url = `${this.brokerUrl}/events${qs}`
    this.log(`Connecting to broker at ${url}`)

    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
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
        this.scheduleReconnect(req)
      })

      res.on('error', (err) => {
        this.log(`SSE response error: ${err.message}`)
        this.scheduleReconnect(req)
      })
    })

    req.on('error', (err) => {
      this.log(`SSE request error: ${err.message}`)
      this.scheduleReconnect(req)
    })

    this.currentRequest = req
  }

  /**
   * Retry, but only on behalf of the connection that is still the live one.
   *
   * `reconnectForIdentity` tears its predecessor down deliberately, and that
   * teardown fires the same end/error handlers a dropped broker fires. Without
   * this check the orphan would come back ~2s later alongside the identified
   * stream and every event would arrive twice.
   */
  private scheduleReconnect(from: http.ClientRequest): void {
    if (this.stopped) return
    if (this.currentRequest !== from) {
      this.log('Ignoring reconnect for a superseded connection')
      return
    }
    this.log(`Reconnecting in ${RECONNECT_DELAY_MS}ms...`)
    setTimeout(() => {
      if (this.currentRequest !== from) return
      this.connect()
    }, RECONNECT_DELAY_MS)
  }

  processLocalEvent(event: BrokerLocalEvent): void {
    this.log(
      `LOCAL EVENT: type=${event.type} channel=${event.channel ?? 'none'} topicId=${event.topicId ?? 'none'} sender=${event.sender ?? 'none'}`,
    )
    this.handleLocalEvent(event).catch((err) => {
      this.log(`LOCAL HANDLE ERROR: ${err}`)
    })
  }

  private log(msg: string): void {
    const who = this.session.hasName() ? this.session.displayName : `pid${process.pid}`
    const line = `[${new Date().toISOString()}] [${who}] ${msg}\n`
    appendFileSync(LOG_FILE, line)
  }

  private channelSubscribed(channel: string | undefined): boolean {
    if (!channel) return false
    return this.context.isChannelSubscribed(channel)
  }

  private async handleLocalEvent(event: BrokerLocalEvent): Promise<void> {
    switch (event.type) {
      case 'topic_created': {
        if (!event.topic) {
          this.log(`DROPPED: topic_created with no topic field`)
          return
        }
        const channel = normalizeChannelName(event.channel ?? event.topic.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED topic_created: channel "${channel}" not subscribed`)
          return
        }
        if (event.topic.creator && this.session.isExactSelf(event.topic.creator)) {
          this.log(`DROPPED: self topic_created from ${event.topic.creator}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.topic.creator,
          text: `New topic in "${channel}": "${event.topic.topic}"`,
          ts: event.topic.createdAt ?? new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: undefined,
        }
        this.log(`PUSHING topic_created to Claude: "${event.topic.topic}"`)
        await this.bus.push(msg)
        return
      }
      case 'message': {
        const channel = normalizeChannelName(event.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED message: channel "${channel}" not subscribed`)
          return
        }
        if (!event.topicId || !this.context.isTopicJoined(event.topicId)) {
          this.log(`DROPPED message: topic ${event.topicId ?? 'none'} not joined`)
          return
        }
        if (event.sender && this.session.isExactSelf(event.sender)) {
          this.log(`DROPPED: self message from ${event.sender}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.sender ?? 'unknown',
          text: event.text ?? '',
          ts: event.ts ?? new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: event.topicId,
        }
        this.log(`PUSHING message to Claude: sender=${msg.sender} text="${msg.text.slice(0, 80)}"`)
        await this.bus.push(msg)
        return
      }
      case 'topic_archived': {
        const channel = normalizeChannelName(event.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED topic_archived: channel "${channel}" not subscribed`)
          return
        }
        if (!event.topicId || !this.context.isTopicJoined(event.topicId)) {
          this.log(`DROPPED topic_archived: topic ${event.topicId ?? 'none'} not joined`)
          return
        }
        if (event.archivedBy && this.session.isExactSelf(event.archivedBy)) {
          this.log(`DROPPED: self topic_archived from ${event.archivedBy}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.archivedBy ?? 'unknown',
          text: 'Topic archived',
          ts: new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: event.topicId,
        }
        this.log(`PUSHING topic_archived to Claude`)
        await this.bus.push(msg)
        return
      }
      case 'topic_unarchived': {
        const channel = normalizeChannelName(event.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED topic_unarchived: channel "${channel}" not subscribed`)
          return
        }
        if (!event.topicId || !this.context.isTopicJoined(event.topicId)) {
          this.log(`DROPPED topic_unarchived: topic ${event.topicId ?? 'none'} not joined`)
          return
        }
        if (event.unarchivedBy && this.session.isExactSelf(event.unarchivedBy)) {
          this.log(`DROPPED: self topic_unarchived from ${event.unarchivedBy}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.unarchivedBy ?? 'unknown',
          text: 'Topic unarchived',
          ts: new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: event.topicId,
        }
        this.log(`PUSHING topic_unarchived to Claude`)
        await this.bus.push(msg)
        return
      }
      case 'broadcast': {
        const channel = normalizeChannelName(event.channel ?? '')
        if (!this.channelSubscribed(channel)) {
          this.log(`DROPPED broadcast: channel "${channel}" not subscribed`)
          return
        }
        if (event.sender && this.session.isExactSelf(event.sender)) {
          this.log(`DROPPED: self broadcast from ${event.sender}`)
          return
        }
        const msg: ParsedMessage = {
          sender: event.sender ?? 'unknown',
          text: event.text ?? '',
          ts: event.ts ?? new Date().toISOString(),
          channel,
          channelName: channel,
          threadTs: undefined,
        }
        this.log(`PUSHING broadcast to Claude: sender=${msg.sender} text="${msg.text.slice(0, 80)}"`)
        await this.bus.push(msg)
        return
      }
    }
  }
}
