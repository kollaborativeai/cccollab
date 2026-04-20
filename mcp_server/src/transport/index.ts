/**
 * Transport abstraction for cccollab's MCP server.
 *
 * The local stdio MCP server spawns a local broker and subscribes to its
 * SSE stream. CCC-3 adds an optional hosted-mode path that also talks to a
 * shared Convex backend. Both paths implement the same write surface so
 * the tool implementations in `src/tools/*.ts` stay uniform and don't
 * carry conditionals for "local vs hosted".
 *
 * Scope today (commit A): writes only. The inbound event subscription for
 * both transports continues to flow through `BrokerEventListener` →
 * `MessageBus` unchanged, so behaviour is identical to pre-refactor.
 * Commit B adds a subscription surface to this interface alongside the
 * hosted transport and a deduplication layer.
 */

export type TransportSource = 'local' | 'hosted'

/** Subset of session attributes that crosses transport boundaries. */
export interface TransportSession {
  name: string
  objective?: string
  machine?: string
  channels: string[]
  registeredAt?: string
}

/** Channel summary as surfaced by `list_channels`. */
export interface TransportChannel {
  name: string
  subscriberCount: number
}

/** Topic summary as surfaced by `list_topics`. */
export interface TransportTopic {
  id: string
  topic: string
  channel: string
  creator: string
  state: string
  createdAt: string
  messageCount?: number
}

/** Historical message as returned by `joinTopic` to hydrate the UI. */
export interface TransportTopicMessage {
  sender: string
  text: string
  ts: string
}

/**
 * A transport is the outbound face of one broker path (local HTTP broker
 * today; hosted Convex deployment in commit B).
 *
 * Transports are stateless above the wire level: they do NOT track which
 * channels the caller is subscribed to or which topics they've joined.
 * That state lives in `ActiveContext` and is the tool layer's business.
 */
export interface Transport {
  /** Provenance tag used by the inbound layer to attribute events. */
  readonly source: TransportSource

  /** False when the transport has self-disabled (graceful degradation). */
  enabled: boolean

  // ─── Identity ─────────────────────────────────────────────────────────
  introduce(args: { sessionName: string; objective?: string }): Promise<void>

  // ─── Channels ─────────────────────────────────────────────────────────
  joinChannel(args: { sessionName: string; channel: string }): Promise<{ subscriberCount: number }>
  leaveChannel(args: { sessionName: string; channel: string }): Promise<void>
  listChannels(args: { sessionName?: string }): Promise<TransportChannel[]>
  broadcast(args: { sessionName: string; channel: string; text: string }): Promise<void>

  // ─── Topics ───────────────────────────────────────────────────────────
  createTopic(args: { sessionName: string; channel: string; topic: string }): Promise<TransportTopic>
  listTopics(args: { sessionName?: string; channel?: string; includeArchived?: boolean }): Promise<TransportTopic[]>
  getTopicById(args: { sessionName: string; topicId: string }): Promise<TransportTopic | null>
  joinTopic(args: {
    sessionName: string
    topicId: string
  }): Promise<{ channel?: string; history: TransportTopicMessage[] }>
  leaveTopic(args: { sessionName: string; topicId: string }): Promise<void>
  archiveTopic(args: { sessionName: string; topicId: string }): Promise<void>
  unarchiveTopic(args: { sessionName: string; topicId: string }): Promise<void>
  sendTopicMessage(args: { sessionName: string; topicId: string; text: string }): Promise<void>

  // ─── Sessions & DMs ───────────────────────────────────────────────────
  listSessions(args: { channel?: string }): Promise<TransportSession[]>
  sendDirectMessage(args: {
    fromSessionName: string
    toSessionName: string
    text: string
  }): Promise<{ viaChannel?: string }>

  // ─── Lifecycle ────────────────────────────────────────────────────────
  /** Best-effort teardown on shutdown. Must not throw. */
  deregisterSession(args: { sessionName: string }): Promise<void>
}

/**
 * Raised by transports when the backend rejects a new active topic
 * because its normalized name is already taken. Tool layer surfaces this
 * as a structured "409"-equivalent to Claude.
 */
export class TopicNameConflictError extends Error {
  readonly code = 'TOPIC_NAME_CONFLICT' as const
  constructor(message: string) {
    super(message)
    this.name = 'TopicNameConflictError'
  }
}

/**
 * Raised when a DM fails because sender and recipient don't share a
 * channel (broker 403) or the recipient is unknown (broker 404).
 */
export class DmDeliveryError extends Error {
  readonly code = 'DM_DELIVERY_FAILED' as const
  constructor(message: string) {
    super(message)
    this.name = 'DmDeliveryError'
  }
}
