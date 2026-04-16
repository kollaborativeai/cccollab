export type TopicSource = 'local' | 'slack'

interface JoinedTopic {
  topicName: string
  source: TopicSource
}

export class ActiveContext {
  private channelId: string | undefined
  private channelName: string | undefined
  private activeThreadTs: string | undefined
  private activeTopicName: string | undefined
  private activeTopicSource: TopicSource | undefined
  private readonly joinedTopics = new Map<string, JoinedTopic>() // threadTs/topicId -> { topicName, source }

  setChannel(channelId: string, channelName: string): void {
    this.channelId = channelId
    this.channelName = channelName
    this.activeThreadTs = undefined
    this.activeTopicName = undefined
    this.activeTopicSource = undefined
    this.joinedTopics.clear()
  }

  joinTopic(threadTs: string, topicName: string, source: TopicSource = 'slack'): void {
    this.joinedTopics.set(threadTs, { topicName, source })
    this.activeThreadTs = threadTs
    this.activeTopicName = topicName
    this.activeTopicSource = source
  }

  leaveTopic(threadTs: string): void {
    this.joinedTopics.delete(threadTs)
    if (this.activeThreadTs === threadTs) {
      this.activeThreadTs = undefined
      this.activeTopicName = undefined
      this.activeTopicSource = undefined
    }
  }

  clearChannel(): void {
    this.channelId = undefined
    this.channelName = undefined
    this.activeThreadTs = undefined
    this.activeTopicName = undefined
    this.activeTopicSource = undefined
    this.joinedTopics.clear()
  }

  clearTopic(): void {
    if (this.activeThreadTs) {
      this.joinedTopics.delete(this.activeThreadTs)
    }
    this.activeThreadTs = undefined
    this.activeTopicName = undefined
    this.activeTopicSource = undefined
  }

  isTopicJoined(threadTs: string): boolean {
    return this.joinedTopics.has(threadTs)
  }

  getChannelId(): string {
    if (!this.channelId) throw new Error('No active channel. Use join_channel first.')
    return this.channelId
  }

  getChannelName(): string {
    if (!this.channelName) throw new Error('No active channel. Use join_channel first.')
    return this.channelName
  }

  getThreadTs(): string {
    if (!this.activeThreadTs) throw new Error('No active topic. Use join_topic or start_topic first.')
    return this.activeThreadTs
  }

  getTopicName(): string | undefined {
    return this.activeTopicName
  }

  getTopicSource(): TopicSource | undefined {
    return this.activeTopicSource
  }

  findJoinedTopic(query: string): { threadTs: string; topicName: string; source: TopicSource } | null {
    const q = query.toLowerCase()
    const matches: Array<{ threadTs: string; topicName: string; source: TopicSource }> = []
    for (const [threadTs, { topicName, source }] of this.joinedTopics) {
      if (topicName.toLowerCase().includes(q)) {
        matches.push({ threadTs, topicName, source })
      }
    }
    if (matches.length === 1) return matches[0]!
    return null
  }

  getJoinedTopics(): Array<{ threadTs: string; topicName: string; source: TopicSource }> {
    return [...this.joinedTopics.entries()].map(([threadTs, { topicName, source }]) => ({ threadTs, topicName, source }))
  }

  hasChannel(): boolean { return this.channelId !== undefined }
  hasTopic(): boolean { return this.activeThreadTs !== undefined }
}
