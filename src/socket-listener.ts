import type { SocketModeClient } from '@slack/socket-mode'
import type { WebClient } from '@slack/web-api'
import type { MessageBus } from './message-bus.js'
import type { SubscriptionManager } from './subscriptions.js'
import { SessionManager } from './session.js'
import type { ParsedMessage } from './types.js'

interface SocketModeListenerOptions {
  socketClient: SocketModeClient
  messageBus: MessageBus
  subscriptionManager: SubscriptionManager
  sessionManager: SessionManager
  botUserId: string
  webClient: WebClient
}

const IGNORED_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'channel_archive', 'channel_unarchive',
  'bot_message', 'me_message', 'message_changed', 'message_deleted', 'thread_broadcast',
])

export class SocketModeListener {
  private readonly socket: SocketModeClient
  private readonly bus: MessageBus
  private readonly subs: SubscriptionManager
  private readonly session: SessionManager
  private readonly botUserId: string
  private readonly webClient: WebClient
  private readonly userNameCache = new Map<string, string>()

  constructor(options: SocketModeListenerOptions) {
    this.socket = options.socketClient
    this.bus = options.messageBus
    this.subs = options.subscriptionManager
    this.session = options.sessionManager
    this.botUserId = options.botUserId
    this.webClient = options.webClient

    this.socket.on('message', (payload) =>
      this.handleMessage(payload).catch((err) => {
        console.error('Failed to handle message:', err)
      })
    )
  }

  async start(): Promise<void> {
    await this.socket.start()
  }

  private async handleMessage(payload: {
    ack: () => Promise<void> | void
    event: {
      type: string; subtype?: string; channel: string
      text?: string; ts: string; thread_ts?: string; user?: string
    }
  }): Promise<void> {
    await payload.ack()
    const { event } = payload

    if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)) return
    if (!this.subs.isSubscribed(event.channel)) return
    if (event.user === this.botUserId) return

    const text = event.text ?? ''
    const parsed = SessionManager.parse(text)

    let sender: string
    let messageText: string

    if (parsed) {
      if (this.session.isSelf(parsed.sender)) return
      sender = parsed.sender
      messageText = parsed.text
    } else {
      const userId = event.user ?? 'unknown'
      const displayName = await this.resolveUserName(userId)
      sender = `human:${displayName}`
      messageText = text
    }

    const channelName = this.subs.getChannelName(event.channel)

    const msg: ParsedMessage = {
      sender, text: messageText, ts: event.ts, channel: event.channel,
      channelName,
      threadTs: event.thread_ts,
    }

    this.bus.push(msg).catch((err) => {
      console.error('Failed to push message to bus:', err)
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
