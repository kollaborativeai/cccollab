/**
 * Transport abstraction for cccollab's local stdio MCP server.
 *
 * The local stdio MCP server always spawns a local broker transport at
 * the reserved location name `"local"`. CCC-3 adds an arbitrary number
 * of named non-local locations, each wrapping its own Convex deployment
 * (e.g. `"flatout"`, `"kollaborative"`). Channels and the topics they
 * contain are namespaced by their location: a "dev" channel at one
 * location and a "dev" channel at another location are two distinct
 * channels. Each channel-addressed or topic-addressed tool call routes
 * to the single transport that owns that channel / topic; list ops
 * query all enabled transports and union the results tagged by
 * `location`.
 *
 * `ChannelLocation` is a free-form string - the set of valid names is
 * whatever the resolved config lists under `locations`. The only
 * reserved name is `"local"`, which is always available even when the
 * config doesn't mention it.
 */

export type ChannelLocation = string

/** Provenance tag carried on inbound events. Same values as the
 *  user-facing `location` on channels/topics/sessions. */
export type TransportSource = ChannelLocation

/** Reserved name for the in-process broker location. */
export const LOCAL_LOCATION: ChannelLocation = 'local'

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
  messageCount?: number
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

/** One message in a paged read-history result. */
export interface TransportHistoryMessage {
  sender: string
  senderSessionName?: string
  text: string
  ts: string
}

/** A page of read history. `oldestTs` is the cursor for the next `before`. */
export interface TransportHistoryPage {
  messages: TransportHistoryMessage[]
  hasMore: boolean
  oldestTs?: string
}

/**
 * A transport is the outbound face of one broker path: the in-process
 * local broker today, plus an optional remote Convex deployment.
 *
 * Transports are stateless above the wire level: they do NOT track which
 * channels the caller is subscribed to or which topics they've joined.
 * That state lives in `ActiveContext` and is the tool layer's business.
 */
export interface Transport {
  /** Provenance tag used by the inbound layer to attribute events and
   *  by the router in `server.ts` to dispatch channel/topic-addressed
   *  operations. */
  readonly source: TransportSource

  /** False when the transport has self-disabled (graceful degradation). */
  enabled: boolean

  /**
   * Does this transport's id-space contain the given topic id? Used by
   * the router to dispatch `join_topic`, `archive_topic`, etc. based on
   * the id format: broker-issued topic ids are RFC 4122 UUIDs; Convex
   * `Id<'topics'>` are base32-ish and never match the UUID pattern.
   * Each implementation returns `true` for ids it owns.
   */
  hasTopic(topicId: string): boolean

  // ─── Identity ─────────────────────────────────────────────────────────
  introduce(args: { sessionName: string; objective?: string; organizationId?: string }): Promise<void>

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

  // ─── Message history ──────────────────────────────────────────────────
  readChannelMessages(args: { channel: string; limit?: number; before?: number }): Promise<TransportHistoryPage>
  readTopicMessages(args: { topicId: string; limit?: number; before?: number }): Promise<TransportHistoryPage>
  readDmThread(args: { peerSessionName: string; limit?: number; before?: number }): Promise<TransportHistoryPage>

  // ─── Lifecycle ────────────────────────────────────────────────────────
  /** Best-effort teardown on shutdown. Must not throw. */
  deregisterSession(args: { sessionName: string }): Promise<void>

  /**
   * Release every resource this transport holds: reactive subscriptions,
   * network clients, timers, pending retries. Idempotent; safe to call
   * on a transport that already self-disabled. Must not throw.
   *
   * Optional because the local transport is stateless at the wire level
   * (it only makes one-shot fetch calls); only transports that hold
   * long-lived state (e.g. the remote ConvexClient websocket) need to
   * implement it. Callers that want to tear down a transport should
   * invoke this iff it is defined.
   */
  shutdown?(): Promise<void>
}

/** UUID v4 pattern as emitted by the local broker. */
export const BROKER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
