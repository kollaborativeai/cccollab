import { LOCAL_LOCATION, type ChannelLocation } from './transport/index.js'

export type ChannelSource = 'manual' | 'fallback' | 'env' | 'cccollab.json'

/** Identifies a channel by name AND location. A "dev" local channel and a
 *  "dev" remote channel are two distinct entities. Channel state (session
 *  subscriptions, joined topics) is keyed by this pair everywhere. */
export interface ChannelRef {
  name: string
  location: ChannelLocation
}

interface SubscribedChannel {
  name: string
  location: ChannelLocation
  source: ChannelSource
}

interface JoinedTopic {
  topicName: string
  channel: string
  location: ChannelLocation
}

/** Canonical channel-name form used everywhere: trimmed + lowercased. */
export function normalizeChannelName(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Compose the Map key for a channel. Never persisted; recomputed from
 *  `{name, location}` so the shape stays the single source of truth. */
function channelKey(name: string, location: ChannelLocation): string {
  return `${location}::${name}`
}

export class ActiveContext {
  private activeThreadTs: string | undefined
  private activeTopicName: string | undefined
  private activeChannel: ChannelRef | undefined
  private readonly subscribed = new Map<string, SubscribedChannel>()
  private readonly joinedTopics = new Map<string, JoinedTopic>()

  joinChannel(
    name: string,
    source: ChannelSource,
    location: ChannelLocation = 'local',
  ): { channel: string; location: ChannelLocation; becameActive: boolean } {
    const channel = normalizeChannelName(name)
    if (!channel) throw new Error('Channel name must be non-empty')
    const key = channelKey(channel, location)
    if (!this.subscribed.has(key)) {
      this.subscribed.set(key, { name: channel, location, source })
    }
    let becameActive = false
    if (this.activeChannel === undefined) {
      this.activeChannel = { name: channel, location }
      becameActive = true
    }
    return { channel, location, becameActive }
  }

  leaveChannel(
    name: string,
    location: ChannelLocation = 'local',
  ): { channel: string; location: ChannelLocation; removed: boolean; newActive: ChannelRef | undefined } {
    const channel = normalizeChannelName(name)
    const key = channelKey(channel, location)
    const removed = this.subscribed.delete(key)
    // Drop any joined topics in this channel+location.
    for (const [threadTs, topic] of [...this.joinedTopics]) {
      if (topic.channel === channel && topic.location === location) {
        this.joinedTopics.delete(threadTs)
      }
    }
    if (this.activeChannel && this.activeChannel.name === channel && this.activeChannel.location === location) {
      const first = [...this.subscribed.values()][0]
      this.activeChannel = first ? { name: first.name, location: first.location } : undefined
      if (this.activeThreadTs) {
        const stillJoined = this.joinedTopics.get(this.activeThreadTs)
        if (!stillJoined) {
          this.activeThreadTs = undefined
          this.activeTopicName = undefined
        }
      }
    }
    return { channel, location, removed, newActive: this.activeChannel }
  }

  setActiveChannel(name: string, location: ChannelLocation = 'local'): void {
    const channel = normalizeChannelName(name)
    const key = channelKey(channel, location)
    if (!this.subscribed.has(key)) {
      throw new Error(`Not subscribed to channel "${channel}" (${location}). Use join_channel first.`)
    }
    this.activeChannel = { name: channel, location }
  }

  /** Active channel name (pre-breaking-change getter). Returns the name
   *  only; callers that need to route by location should use
   *  `getActiveChannelRef`. Kept so tool error messages stay terse. */
  getActiveChannel(): string | undefined {
    return this.activeChannel?.name
  }

  getActiveChannelRef(): ChannelRef | undefined {
    return this.activeChannel ? { ...this.activeChannel } : undefined
  }

  /** Back-compat helper: does a channel with this name exist at ANY
   *  location? Useful for error messages where a single location isn't
   *  known yet. Callers that must route precisely should use the
   *  location-qualified form. */
  isChannelSubscribed(name: string, location?: ChannelLocation): boolean {
    const channel = normalizeChannelName(name)
    if (location) return this.subscribed.has(channelKey(channel, location))
    for (const entry of this.subscribed.values()) {
      if (entry.name === channel) return true
    }
    return false
  }

  getChannelSource(name: string, location?: ChannelLocation): ChannelSource | undefined {
    const channel = normalizeChannelName(name)
    if (location) return this.subscribed.get(channelKey(channel, location))?.source
    for (const entry of this.subscribed.values()) {
      if (entry.name === channel) return entry.source
    }
    return undefined
  }

  /** Returns the location of a subscribed channel. `ChannelLocation` is
   *  a free-form string - the user may configure arbitrary names
   *  (`"flatout"`, `"acme"`) alongside or instead of the reserved
   *  `"local"`. We check `"local"` first as a deterministic tie-break
   *  (matching the routing preference in `list_sessions`), then fall back
   *  to whichever subscription has this channel name. */
  getChannelLocation(name: string): ChannelLocation | undefined {
    const channel = normalizeChannelName(name)
    if (this.subscribed.has(channelKey(channel, LOCAL_LOCATION))) return LOCAL_LOCATION
    for (const entry of this.subscribed.values()) {
      if (entry.name === channel) return entry.location
    }
    return undefined
  }

  getSubscribedChannels(): Array<{ name: string; location: ChannelLocation; source: ChannelSource }> {
    return [...this.subscribed.values()].map((c) => ({ name: c.name, location: c.location, source: c.source }))
  }

  joinTopic(threadTs: string, topicName: string, channel: string, location: ChannelLocation = 'local'): void {
    const normalized = normalizeChannelName(channel)
    const key = channelKey(normalized, location)
    if (!this.subscribed.has(key)) {
      throw new Error(`Cannot join topic in channel "${normalized}" (${location}) - not subscribed.`)
    }
    this.joinedTopics.set(threadTs, { topicName, channel: normalized, location })
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

  getTopicLocation(): ChannelLocation | undefined {
    if (!this.activeThreadTs) return undefined
    return this.joinedTopics.get(this.activeThreadTs)?.location
  }

  /** Lookup the location of ANY joined topic by its id. */
  getJoinedTopicLocation(threadTs: string): ChannelLocation | undefined {
    return this.joinedTopics.get(threadTs)?.location
  }

  findJoinedTopic(
    query: string,
  ): { threadTs: string; topicName: string; channel: string; location: ChannelLocation } | null {
    const direct = this.joinedTopics.get(query)
    if (direct) {
      return { threadTs: query, topicName: direct.topicName, channel: direct.channel, location: direct.location }
    }

    const q = query.toLowerCase()
    const exact: Array<{ threadTs: string; topicName: string; channel: string; location: ChannelLocation }> = []
    const fuzzy: Array<{ threadTs: string; topicName: string; channel: string; location: ChannelLocation }> = []
    for (const [threadTs, { topicName, channel, location }] of this.joinedTopics) {
      const lower = topicName.toLowerCase()
      if (lower === q) exact.push({ threadTs, topicName, channel, location })
      else if (lower.includes(q)) fuzzy.push({ threadTs, topicName, channel, location })
    }
    if (exact.length === 1) return exact[0]!
    if (exact.length === 0 && fuzzy.length === 1) return fuzzy[0]!
    return null
  }

  getJoinedTopics(): Array<{ threadTs: string; topicName: string; channel: string; location: ChannelLocation }> {
    return [...this.joinedTopics.entries()].map(([threadTs, { topicName, channel, location }]) => ({
      threadTs,
      topicName,
      channel,
      location,
    }))
  }

  hasTopic(): boolean {
    return this.activeThreadTs !== undefined
  }
}
