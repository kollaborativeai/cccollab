export type ChannelSource = 'manual' | 'fallback' | 'env' | 'cccollab.json'

interface SubscribedChannel {
  name: string
  source: ChannelSource
}

interface JoinedTopic {
  topicName: string
  channel: string
}

/** Canonical channel-name form used everywhere: trimmed + lowercased. */
export function normalizeChannelName(raw: string): string {
  return raw.trim().toLowerCase()
}

export class ActiveContext {
  private activeThreadTs: string | undefined
  private activeTopicName: string | undefined
  private activeChannel: string | undefined
  private readonly subscribed = new Map<string, SubscribedChannel>()
  private readonly joinedTopics = new Map<string, JoinedTopic>()

  joinChannel(name: string, source: ChannelSource): { channel: string; becameActive: boolean } {
    const channel = normalizeChannelName(name)
    if (!channel) throw new Error('Channel name must be non-empty')
    if (!this.subscribed.has(channel)) {
      this.subscribed.set(channel, { name: channel, source })
    }
    let becameActive = false
    if (this.activeChannel === undefined) {
      this.activeChannel = channel
      becameActive = true
    }
    return { channel, becameActive }
  }

  leaveChannel(name: string): { channel: string; removed: boolean; newActive: string | undefined } {
    const channel = normalizeChannelName(name)
    const removed = this.subscribed.delete(channel)
    for (const [threadTs, topic] of [...this.joinedTopics]) {
      if (topic.channel === channel) this.joinedTopics.delete(threadTs)
    }
    if (this.activeChannel === channel) {
      const [first] = this.subscribed.keys()
      this.activeChannel = first
      if (this.activeThreadTs) {
        const stillJoined = this.joinedTopics.get(this.activeThreadTs)
        if (!stillJoined) {
          this.activeThreadTs = undefined
          this.activeTopicName = undefined
        }
      }
    }
    return { channel, removed, newActive: this.activeChannel }
  }

  setActiveChannel(name: string): void {
    const channel = normalizeChannelName(name)
    if (!this.subscribed.has(channel)) {
      throw new Error(`Not subscribed to channel "${channel}". Use join_channel first.`)
    }
    this.activeChannel = channel
  }

  getActiveChannel(): string | undefined {
    return this.activeChannel
  }

  isChannelSubscribed(name: string): boolean {
    return this.subscribed.has(normalizeChannelName(name))
  }

  getChannelSource(name: string): ChannelSource | undefined {
    return this.subscribed.get(normalizeChannelName(name))?.source
  }

  getSubscribedChannels(): Array<{ name: string; source: ChannelSource }> {
    return [...this.subscribed.values()].map((c) => ({ name: c.name, source: c.source }))
  }

  joinTopic(threadTs: string, topicName: string, channel: string): void {
    const normalized = normalizeChannelName(channel)
    if (!this.subscribed.has(normalized)) {
      throw new Error(`Cannot join topic in channel "${normalized}" - not subscribed.`)
    }
    this.joinedTopics.set(threadTs, { topicName, channel: normalized })
    this.activeThreadTs = threadTs
    this.activeTopicName = topicName
  }

  leaveTopic(threadTs: string): void {
    this.joinedTopics.delete(threadTs)
    if (this.activeThreadTs === threadTs) {
      this.activeThreadTs = undefined
      this.activeTopicName = undefined
    }
  }

  clearTopic(): void {
    if (this.activeThreadTs) {
      this.joinedTopics.delete(this.activeThreadTs)
    }
    this.activeThreadTs = undefined
    this.activeTopicName = undefined
  }

  isTopicJoined(threadTs: string): boolean {
    return this.joinedTopics.has(threadTs)
  }

  getThreadTs(): string {
    if (!this.activeThreadTs) throw new Error('No active topic. Use join_topic or start_topic first.')
    return this.activeThreadTs
  }

  getTopicName(): string | undefined {
    return this.activeTopicName
  }

  getTopicChannel(): string | undefined {
    if (!this.activeThreadTs) return undefined
    return this.joinedTopics.get(this.activeThreadTs)?.channel
  }

  findJoinedTopic(query: string): { threadTs: string; topicName: string; channel: string } | null {
    const direct = this.joinedTopics.get(query)
    if (direct) return { threadTs: query, topicName: direct.topicName, channel: direct.channel }

    const q = query.toLowerCase()
    const exact: Array<{ threadTs: string; topicName: string; channel: string }> = []
    const fuzzy: Array<{ threadTs: string; topicName: string; channel: string }> = []
    for (const [threadTs, { topicName, channel }] of this.joinedTopics) {
      const lower = topicName.toLowerCase()
      if (lower === q) exact.push({ threadTs, topicName, channel })
      else if (lower.includes(q)) fuzzy.push({ threadTs, topicName, channel })
    }
    if (exact.length === 1) return exact[0]!
    if (exact.length === 0 && fuzzy.length === 1) return fuzzy[0]!
    return null
  }

  getJoinedTopics(): Array<{ threadTs: string; topicName: string; channel: string }> {
    return [...this.joinedTopics.entries()].map(([threadTs, { topicName, channel }]) => ({
      threadTs,
      topicName,
      channel,
    }))
  }

  hasTopic(): boolean {
    return this.activeThreadTs !== undefined
  }
}
