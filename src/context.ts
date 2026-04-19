interface JoinedTopic {
  topicName: string
  source: 'local'
}

export class ActiveContext {
  private activeThreadTs: string | undefined
  private activeTopicName: string | undefined
  private activeTopicSource: 'local' | undefined
  private localJoined = false
  private readonly joinedTopics = new Map<string, JoinedTopic>() // threadTs/topicId -> { topicName, source }

  joinLocalChannel(): void {
    this.localJoined = true
  }

  isLocalJoined(): boolean {
    return this.localJoined
  }

  joinTopic(threadTs: string, topicName: string, source: 'local'): void {
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

  getThreadTs(): string {
    if (!this.activeThreadTs) throw new Error('No active topic. Use join_topic or start_topic first.')
    return this.activeThreadTs
  }

  getTopicName(): string | undefined {
    return this.activeTopicName
  }

  getTopicSource(): 'local' | undefined {
    return this.activeTopicSource
  }

  findJoinedTopic(query: string): { threadTs: string; topicName: string; source: 'local' } | null {
    // Exact topicId/threadTs match wins
    const direct = this.joinedTopics.get(query)
    if (direct) return { threadTs: query, topicName: direct.topicName, source: direct.source }

    const q = query.toLowerCase()
    const exact: Array<{ threadTs: string; topicName: string; source: 'local' }> = []
    const fuzzy: Array<{ threadTs: string; topicName: string; source: 'local' }> = []
    for (const [threadTs, { topicName, source }] of this.joinedTopics) {
      const lower = topicName.toLowerCase()
      if (lower === q) exact.push({ threadTs, topicName, source })
      else if (lower.includes(q)) fuzzy.push({ threadTs, topicName, source })
    }
    if (exact.length === 1) return exact[0]!
    if (exact.length === 0 && fuzzy.length === 1) return fuzzy[0]!
    return null
  }

  getJoinedTopics(): Array<{ threadTs: string; topicName: string; source: 'local' }> {
    return [...this.joinedTopics.entries()].map(([threadTs, { topicName, source }]) => ({ threadTs, topicName, source }))
  }

  hasTopic(): boolean { return this.activeThreadTs !== undefined }
}
