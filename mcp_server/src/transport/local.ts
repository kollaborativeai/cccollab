import {
  BROKER_UUID_PATTERN,
  TopicNameConflictError,
  type Transport,
  type TransportChannel,
  type TransportDmMessage,
  type TransportDmPage,
  type TransportDmResult,
  type TransportHistoryPage,
  type TransportSession,
  type TransportTopic,
  type TransportTopicMessage,
} from './index.js'

/**
 * Local transport: wraps the in-process HTTP broker (`broker.ts`).
 *
 * Every method maps one-to-one onto a broker HTTP endpoint. No caching,
 * no retries - the broker is an in-process peer and failures propagate
 * to the tool layer.
 *
 * The inbound SSE event stream is handled separately by
 * `BrokerEventListener` → `MessageBus`. That flow is unchanged in
 * commit A; commit B folds it under this abstraction.
 */
export class LocalTransport implements Transport {
  readonly source = 'local'
  enabled = true

  /**
   * This session's registration id at the broker, minted by `introduce`
   * (KAI-514 AC2). Every session-scoped call carries it instead of the
   * display name: names collide between concurrent sessions and are reused
   * by relaunches, so a name-addressed call can land on the wrong
   * registration. Undefined until `introduce` has run.
   */
  private registrationId: string | undefined

  constructor(private readonly brokerPort: number) {}

  /** The registration id, for the SSE listener that has to tag its stream
   *  with it so DMs can reach this session. */
  get sessionId(): string | undefined {
    return this.registrationId
  }

  /** Session-scoped calls are gated behind `introduce` at the tool layer, so
   *  a missing id is a wiring bug, not a user error - say so plainly rather
   *  than silently addressing the broker with a display name again. */
  private requireId(): string {
    if (!this.registrationId) {
      throw new Error('Not registered with the local broker yet - call introduce first.')
    }
    return this.registrationId
  }

  /** Local broker emits topic ids as RFC 4122 UUIDs. */
  hasTopic(topicId: string): boolean {
    return BROKER_UUID_PATTERN.test(topicId)
  }

  // ─── Identity ─────────────────────────────────────────────────────────
  async introduce(args: { sessionName: string; objective?: string; organizationId?: string }): Promise<void> {
    // The local broker is single-tenant; organizationId is intentionally ignored.
    // Echoing our own id (when we have one) makes a repeat introduce a rename
    // of THIS registration rather than a second one; the first call has none,
    // so the broker mints a fresh id for this process (KAI-514 AC2).
    const body = await this.brokerPost<{ ok: boolean; id: string }>('/sessions', {
      name: args.sessionName,
      objective: args.objective,
      id: this.registrationId,
    })
    if (!body.id) {
      // The id is the only way this session can be addressed or can address
      // anyone (KAI-514). A broker that doesn't return one leaves us mute -
      // fail loudly instead of degrading into name-based guessing.
      throw new Error('Broker did not return a registration id for this session.')
    }
    this.registrationId = body.id
  }

  // ─── Channels ─────────────────────────────────────────────────────────
  async joinChannel(args: { sessionName: string; channel: string }): Promise<{ subscriberCount: number }> {
    const body = await this.brokerPost<{ subscriberCount?: number }>('/channels/join', {
      sessionId: this.requireId(),
      channel: args.channel,
    })
    return { subscriberCount: body.subscriberCount ?? 1 }
  }

  async leaveChannel(args: { sessionName: string; channel: string }): Promise<void> {
    await this.brokerPost('/channels/leave', { sessionId: this.requireId(), channel: args.channel })
  }

  async listChannels(args: { sessionName?: string }): Promise<TransportChannel[]> {
    // `sessionName` here means "scope to me". Before introduce there is no
    // registration to scope to, so the honest answer is none - not "all".
    if (args.sessionName !== undefined && !this.registrationId) return []
    const qs = args.sessionName ? `?sessionId=${encodeURIComponent(this.requireId())}` : ''
    const data = await this.brokerGet<{ channels: TransportChannel[] }>(`/channels${qs}`)
    return data.channels
  }

  async broadcast(args: { sessionName: string; channel: string; text: string }): Promise<void> {
    await this.brokerPost('/broadcast', {
      sessionId: this.requireId(),
      channel: args.channel,
      text: args.text,
    })
  }

  // ─── Topics ───────────────────────────────────────────────────────────
  async createTopic(args: { sessionName: string; channel: string; topic: string }): Promise<TransportTopic> {
    const res = await fetch(`${this.base()}/topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: args.topic, sessionId: this.requireId(), channel: args.channel }),
    })
    if (res.status === 409) {
      const body = (await res.json()) as { error: string }
      throw new TopicNameConflictError(body.error)
    }
    if (!res.ok) {
      throw new Error(`Broker ${res.status}: ${await res.text()}`)
    }
    return (await res.json()) as TransportTopic
  }

  async listTopics(args: {
    sessionName?: string
    channel?: string
    includeArchived?: boolean
  }): Promise<TransportTopic[]> {
    const params = new URLSearchParams()
    if (args.includeArchived) params.set('include_archived', 'true')
    if (args.channel) params.set('channel', args.channel)
    else if (args.sessionName) params.set('sessionId', this.requireId())
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await this.brokerGet<{ topics: TransportTopic[] }>(`/topics${qs}`)
    return data.topics
  }

  async getTopicById(args: { sessionName: string; topicId: string }): Promise<TransportTopic | null> {
    const qs = `?sessionId=${encodeURIComponent(this.requireId())}`
    const res = await fetch(`${this.base()}/topics/${encodeURIComponent(args.topicId)}${qs}`)
    if (!res.ok) return null
    const data = (await res.json()) as { topic: TransportTopic }
    return data.topic
  }

  async joinTopic(args: {
    sessionName: string
    topicId: string
  }): Promise<{ channel?: string; history: TransportTopicMessage[] }> {
    const data = await this.brokerPost<{ channel?: string; messages: TransportTopicMessage[] }>(
      `/topics/${encodeURIComponent(args.topicId)}/join`,
      { sessionId: this.requireId() },
    )
    return { channel: data.channel, history: data.messages }
  }

  async leaveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    await this.brokerPost(`/topics/${encodeURIComponent(args.topicId)}/leave`, {
      sessionId: this.requireId(),
    })
  }

  async archiveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    await this.brokerPost(`/topics/${encodeURIComponent(args.topicId)}/archive`, {
      sessionId: this.requireId(),
    })
  }

  async unarchiveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    await this.brokerPost(`/topics/${encodeURIComponent(args.topicId)}/unarchive`, {
      sessionId: this.requireId(),
    })
  }

  async sendTopicMessage(args: { sessionName: string; topicId: string; text: string }): Promise<void> {
    await this.brokerPost(`/topics/${encodeURIComponent(args.topicId)}/messages`, {
      sessionId: this.requireId(),
      text: args.text,
    })
  }

  // ─── Sessions ─────────────────────────────────────────────────────────
  async listSessions(args: { channel?: string }): Promise<TransportSession[]> {
    const params = new URLSearchParams()
    if (args.channel) params.set('channel', args.channel)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await this.brokerGet<{ sessions: TransportSession[] }>(`/sessions${qs}`)
    return data.sessions
  }

  // ─── Direct messages (KAI-514) ──────────────────────────────────────────
  async sendSessionMessage(args: {
    sessionName: string
    toSessionId: string
    text: string
  }): Promise<TransportDmResult> {
    return this.brokerPost<TransportDmResult>(`/sessions/${encodeURIComponent(args.toSessionId)}/dm`, {
      fromId: this.requireId(),
      text: args.text,
    })
  }

  async readSessionMessages(args: {
    sessionName: string
    withSessionId: string
    limit?: number
    before?: number
  }): Promise<TransportDmPage> {
    const params = new URLSearchParams({ asId: this.requireId() })
    if (args.limit !== undefined) params.set('limit', String(args.limit))
    if (args.before !== undefined) params.set('before', String(args.before))
    const data = await this.brokerGet<{ messages: TransportDmMessage[]; hasMore: boolean }>(
      `/sessions/${encodeURIComponent(args.withSessionId)}/dm?${params.toString()}`,
    )
    return {
      messages: data.messages,
      hasMore: data.hasMore,
      oldestTs: data.messages.length > 0 ? data.messages[0]!.ts : undefined,
    }
  }

  // ─── Message history ──────────────────────────────────────────────────
  // Channel broadcasts are fanned out over SSE and never persisted, so the
  // local broker has no channel history to page. Rather than return a silent
  // empty page (which reads as "no messages"), surface the limitation.
  async readChannelMessages(_args: {
    channel: string
    limit?: number
    before?: number
  }): Promise<TransportHistoryPage> {
    throw new Error(
      'Channel broadcast history is not available on the local transport — broadcasts are delivered live and not persisted. Read history is only available for remote locations.',
    )
  }

  // Topic history lives in the broker's memory; page it through the broker's
  // read-history endpoint and map it onto the shared history-page contract.
  async readTopicMessages(args: { topicId: string; limit?: number; before?: number }): Promise<TransportHistoryPage> {
    const params = new URLSearchParams()
    if (args.limit !== undefined) params.set('limit', String(args.limit))
    if (args.before !== undefined) params.set('before', String(args.before))
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await this.brokerGet<{
      messages: Array<{ sender: string; text: string; ts: number }>
      hasMore: boolean
    }>(`/topics/${encodeURIComponent(args.topicId)}/messages${qs}`)
    return {
      messages: data.messages.map((m) => ({
        sender: m.sender,
        // The local broker is single-tenant: the sender name *is* the session
        // name, so mirror it onto senderSessionName for parity with remote.
        senderSessionName: m.sender,
        text: m.text,
        ts: m.ts,
      })),
      hasMore: data.hasMore,
      oldestTs: data.messages.length > 0 ? data.messages[0]!.ts : undefined,
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────
  async deregisterSession(_args: { sessionName: string }): Promise<void> {
    // Deregistration is by registration id, not name: a shutdown must never
    // delete a namesake's registration. No id means nothing to tear down.
    const id = this.registrationId
    if (!id) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 750)
    try {
      await fetch(`${this.base()}/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        signal: controller.signal,
      })
    } catch {
      // best-effort
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── internals ────────────────────────────────────────────────────────
  private base(): string {
    return `http://127.0.0.1:${this.brokerPort}`
  }

  private async brokerGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base()}${path}`)
    if (!res.ok) throw new Error(`Broker ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }

  private async brokerPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Broker ${res.status}: ${await res.text()}`)
    return (await res.json()) as T
  }
}
