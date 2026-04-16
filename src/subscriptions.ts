import type { WebClient } from '@slack/web-api'

interface JoinResult {
  channelId: string
  alreadySubscribed: boolean
}

export class SubscriptionManager {
  private readonly subscriptions = new Set<string>()
  private readonly channelCache = new Map<string, string>()
  private readonly client: WebClient
  private channelListLoaded = false

  constructor(client: WebClient) {
    this.client = client
  }

  async join(channelName: string): Promise<JoinResult> {
    const channelId = await this.resolveChannelId(channelName)
    const alreadySubscribed = this.subscriptions.has(channelId)

    // conversations.join only works for public channels.
    // For private channels the bot must be invited first - just verify membership.
    try {
      await this.client.conversations.join({ channel: channelId })
    } catch (err: unknown) {
      const slackError = err as { data?: { error?: string } }
      const errorCode = slackError.data?.error
      if (errorCode === 'method_not_supported_for_channel_type' || errorCode === 'channel_not_found') {
        // Private channel - verify bot is a member by fetching info
        const info = await this.client.conversations.info({ channel: channelId })
        if (!info.channel?.is_member) {
          throw new Error(
            `Cannot join private channel "#${channelName}". Invite the bot first: /invite @Claude Code Collab`
          )
        }
      } else {
        throw err
      }
    }

    this.subscriptions.add(channelId)
    return { channelId, alreadySubscribed }
  }

  leave(channelId: string): void {
    this.subscriptions.delete(channelId)
  }

  isSubscribed(channelId: string): boolean {
    return this.subscriptions.has(channelId)
  }

  getSubscriptions(): string[] {
    return [...this.subscriptions]
  }

  async resolveChannelId(channelName: string): Promise<string> {
    const cached = this.channelCache.get(channelName)
    if (cached) return cached

    if (!this.channelListLoaded) {
      await this.loadChannelList()
    }

    const id = this.channelCache.get(channelName)
    if (!id) {
      throw new Error(`Channel "${channelName}" not found. Make sure the bot is invited to the channel.`)
    }
    return id
  }

  getChannelName(channelId: string): string | undefined {
    for (const [name, id] of this.channelCache) {
      if (id === channelId) return name
    }
    return undefined
  }

  private async loadChannelList(): Promise<void> {
    let cursor: string | undefined
    do {
      const result = await this.client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
        cursor,
      })
      for (const channel of result.channels ?? []) {
        if (channel.id && channel.name) {
          this.channelCache.set(channel.name, channel.id)
        }
      }
      cursor = result.response_metadata?.next_cursor || undefined
    } while (cursor)
    this.channelListLoaded = true
  }
}
