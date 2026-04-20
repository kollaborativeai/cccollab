import { EventEmitter } from 'node:events'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { ParsedMessage } from './types.js'

/**
 * Source tag attached to inbound events as they flow through the bus.
 * `"local"` marks events from the in-process broker's SSE stream;
 * other values are location names from the resolved config for events
 * arriving via remote transports' Convex subscriptions. Any name the
 * user configured under `locations` is valid here, not just a fixed
 * pair.
 */
export type MessageSource = string

/**
 * Window in which two events with the same dedup key are considered
 * duplicates. The broker emits events on the same machine at roughly
 * real-time; Convex subscriptions can push the same-origin message
 * milliseconds to seconds later. 10s covers normal jitter without
 * silencing two genuine identical messages spaced further apart.
 */
const DEDUP_WINDOW_MS = 10_000

/**
 * Cap on the dedup cache. Bounded so a long-lived session doesn't
 * retain memory forever. Entries are evicted continuously by the
 * time-based sweep; this is the hard safety valve.
 */
const MAX_DEDUP_ENTRIES = 2048

/**
 * Build the dedup key for a message. The rule is sensitive enough to
 * catch genuine duplicates ("same sender says `ok` in topic X in the
 * same second") but not so strict that it false-dedupes legitimate
 * identical messages sent back-to-back across seconds.
 *
 * `ts` is rounded to the second because the broker emits ISO
 * millisecond timestamps and Convex writes its own; tolerating a 1s
 * bucket on either side is the expected clock skew between a local
 * broker event and the remote transport's push for the same send.
 */
function dedupKey(msg: ParsedMessage): string {
  const threadOrChannel = msg.threadTs ?? msg.channel
  const ts = Date.parse(msg.ts)
  const secondBucket = Number.isNaN(ts) ? msg.ts : String(Math.floor(ts / 1000))
  return `${msg.sender}|${threadOrChannel}|${secondBucket}|${msg.text}`
}

export class MessageBus extends EventEmitter {
  private readonly mcp: Server
  private readonly dedupSeen = new Map<string, number>()

  constructor(mcp: Server) {
    super()
    this.mcp = mcp
  }

  /**
   * Push one inbound message to the MCP client as a
   * `notifications/claude/channel` tag. `source` tags where the event
   * originated (local broker vs remote Convex subscription). Same-
   * logical-message arrivals within `DEDUP_WINDOW_MS` are dropped so
   * users don't see duplicates when both transports are live and
   * peered.
   *
   * Errors while sending the MCP notification are logged via an event
   * and swallowed on purpose - a transient MCP SDK hiccup must not
   * crash the server or break the inbound subscription.
   */
  async push(msg: ParsedMessage, source: MessageSource = 'local'): Promise<void> {
    const key = dedupKey(msg)
    const now = Date.now()
    this.vacuum(now)
    const last = this.dedupSeen.get(key)
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
      this.emit('dedup:dropped', { msg, source, previousTs: last })
      return
    }
    this.dedupSeen.set(key, now)
    if (this.dedupSeen.size > MAX_DEDUP_ENTRIES) this.trimOldest()

    const meta: Record<string, string> = {
      sender: msg.sender,
      channel: msg.channelName ?? msg.channel,
      channel_id: msg.channel,
      ts: msg.ts,
      source,
    }
    if (msg.threadTs) {
      meta.thread_ts = msg.threadTs
    }

    try {
      await this.mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: msg.text, meta },
      })
    } catch (err) {
      this.emit('notify:error', { msg, source, err })
      return
    }

    this.emit(`channel:${msg.channel}`, msg)
    if (msg.threadTs) {
      this.emit(`thread:${msg.threadTs}`, msg)
    }
  }

  private vacuum(now: number): void {
    // Sweep stale entries once per push. Map stays bounded at
    // MAX_DEDUP_ENTRIES so this is cheap; the alternative (a timer)
    // would need shutdown wiring and carries leak risk.
    for (const [k, ts] of this.dedupSeen) {
      if (now - ts >= DEDUP_WINDOW_MS) {
        this.dedupSeen.delete(k)
      }
    }
  }

  private trimOldest(): void {
    // Only called when we overshoot MAX_DEDUP_ENTRIES after a vacuum,
    // which shouldn't happen in normal operation. Delete the oldest
    // entry to get back under the cap.
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [k, ts] of this.dedupSeen) {
      if (ts < oldestTs) {
        oldestTs = ts
        oldestKey = k
      }
    }
    if (oldestKey !== null) this.dedupSeen.delete(oldestKey)
  }
}
