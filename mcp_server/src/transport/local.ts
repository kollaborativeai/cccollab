import {
  BROKER_UUID_PATTERN,
  TopicNameConflictError,
  type Transport,
  type TransportChannel,
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

  constructor(private readonly brokerPort: number) {}

  /** Local broker emits topic ids as RFC 4122 UUIDs. */
  hasTopic(topicId: string): boolean {
    return BROKER_UUID_PATTERN.test(topicId)
  }

  // ─── Identity ─────────────────────────────────────────────────────────
  async introduce(args: { sessionName: string; objective?: string; organizationId?: string }): Promise<void> {
    // The local broker is single-tenant; organizationId is intentionally ignored.
    await this.brokerPost('/sessions', { name: args.sessionName, objective: args.objective })
  }

  // ─── Channels ─────────────────────────────────────────────────────────
  async joinChannel(args: { sessionName: string; channel: string }): Promise<{ subscriberCount: number }> {
    const body = await this.brokerPost<{ subscriberCount?: number }>('/channels/join', {
      sessionId: args.sessionName,
      channel: args.channel,
    })
    return { subscriberCount: body.subscriberCount ?? 1 }
  }

  async leaveChannel(args: { sessionName: string; channel: string }): Promise<void> {
    await this.brokerPost('/channels/leave', { sessionId: args.sessionName, channel: args.channel })
  }

  async listChannels(args: { sessionName?: string }): Promise<TransportChannel[]> {
    const qs = args.sessionName ? `?sessionId=${encodeURIComponent(args.sessionName)}` : ''
    const data = await this.brokerGet<{ channels: TransportChannel[] }>(`/channels${qs}`)
    return data.channels
  }

  async broadcast(args: { sessionName: string; channel: string; text: string }): Promise<void> {
    await this.brokerPost('/broadcast', {
      sender: args.sessionName,
      channel: args.channel,
      text: args.text,
    })
  }

  // ─── Topics ───────────────────────────────────────────────────────────
  async createTopic(args: { sessionName: string; channel: string; topic: string }): Promise<TransportTopic> {
    const res = await fetch(`${this.base()}/topics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: args.topic, creator: args.sessionName, channel: args.channel }),
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
    else if (args.sessionName) params.set('sessionId', args.sessionName)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await this.brokerGet<{ topics: TransportTopic[] }>(`/topics${qs}`)
    return data.topics
  }

  async getTopicById(args: { sessionName: string; topicId: string }): Promise<TransportTopic | null> {
    const qs = `?sessionId=${encodeURIComponent(args.sessionName)}`
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
      { sessionId: args.sessionName },
    )
    return { channel: data.channel, history: data.messages }
  }

  async leaveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    await this.brokerPost(`/topics/${encodeURIComponent(args.topicId)}/leave`, {
      sessionId: args.sessionName,
    })
  }

  async archiveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    await this.brokerPost(`/topics/${encodeURIComponent(args.topicId)}/archive`, {
      archivedBy: args.sessionName,
    })
  }

  async unarchiveTopic(args: { sessionName: string; topicId: string }): Promise<void> {
    await this.brokerPost(`/topics/${encodeURIComponent(args.topicId)}/unarchive`, {})
  }

  async sendTopicMessage(args: { sessionName: string; topicId: string; text: string }): Promise<void> {
    await this.brokerPost(`/topics/${encodeURIComponent(args.topicId)}/messages`, {
      sender: args.sessionName,
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

  // ─── Message history ──────────────────────────────────────────────────
  // The local broker does not expose a paged read-history API; these
  // return empty pages so the interface contract is satisfied.
  async readChannelMessages(_args: {
    channel: string
    limit?: number
    before?: number
  }): Promise<TransportHistoryPage> {
    return { messages: [], hasMore: false }
  }

  async readTopicMessages(_args: { topicId: string; limit?: number; before?: number }): Promise<TransportHistoryPage> {
    return { messages: [], hasMore: false }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────
  async deregisterSession(args: { sessionName: string }): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 750)
    try {
      await fetch(`${this.base()}/sessions/${encodeURIComponent(args.sessionName)}`, {
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
