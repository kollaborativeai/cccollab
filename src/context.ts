export class ActiveContext {
  private channelId: string | undefined
  private channelName: string | undefined
  private threadTs: string | undefined
  private topicName: string | undefined

  setChannel(channelId: string, channelName: string): void {
    this.channelId = channelId
    this.channelName = channelName
    // Changing channel clears active topic
    this.threadTs = undefined
    this.topicName = undefined
  }

  setTopic(threadTs: string, topicName: string): void {
    this.threadTs = threadTs
    this.topicName = topicName
  }

  clearChannel(): void {
    this.channelId = undefined
    this.channelName = undefined
    this.threadTs = undefined
    this.topicName = undefined
  }

  clearTopic(): void {
    this.threadTs = undefined
    this.topicName = undefined
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
    if (!this.threadTs) throw new Error('No active topic. Use join_topic or start_topic first.')
    return this.threadTs
  }

  getTopicName(): string | undefined {
    return this.topicName
  }

  hasChannel(): boolean { return this.channelId !== undefined }
  hasTopic(): boolean { return this.threadTs !== undefined }
}
