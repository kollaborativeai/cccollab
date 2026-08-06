import { EventEmitter } from 'node:events'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { renderInboundText } from './attachments.js'
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
  /**
   * One in-flight delivery chain PER STREAM, keyed by topic when there is one
   * and by channel otherwise. Dedup stays synchronous at the head of `push`, so
   * ordering within a stream is decided by call order rather than by how long
   * each message's attachments take to fetch.
   *
   * Per stream, not per process. Ordering is only meaningful between messages a
   * reader will relate to each other — the screenshot and the sentence about it
   * — and that relation does not cross channels. A single process-wide chain
   * bought the ordering that matters by making every channel wait behind every
   * download: measured, a 2-image message on one channel and a text-only
   * "PROD IS DOWN" on another both landed at t+1603ms.
   *
   * Head-of-line blocking within one stream is bounded by
   * `MESSAGE_DOWNLOAD_BUDGET_MS` (attachments.ts) — a whole-message budget, not
   * a per-fetch timeout, because images are fetched sequentially and n images
   * used to mean n × the per-fetch timeout. It is paid only by later messages
   * in the SAME stream.
   *
   * ponytail: a map of promise chains, not a queue class — each link is released
   * as it settles, and a stream's entry is dropped once it goes idle, so a
   * long-lived process does not retain one promise per channel it has ever seen.
   */
  private readonly tails = new Map<string, Promise<void>>()

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

    // Delivery is serialised behind whatever is already in flight FOR THIS
    // STREAM. Callers fire `void push(...)` once per row from a subscription
    // callback, so before attachments existed the notifications went out in row
    // order simply because nothing awaited in between. Materialising an image
    // inserts a network round-trip, and without this queue every later
    // text-only message overtakes it: the session reads "so revert the
    // migration" before it is shown the screenshot that sentence is about.
    // A different channel has no such relation and waits for nothing.
    const streamKey = msg.threadTs ?? msg.channel
    const tail = this.tails.get(streamKey) ?? Promise.resolve()
    const delivery = tail.then(() => this.deliver(msg, source, meta))
    // One failed delivery must not poison the queue for the next message.
    const settled = delivery.catch(() => {})
    this.tails.set(streamKey, settled)
    // Drop the entry once this stream goes idle. Guarded on identity so a
    // message pushed while this one was in flight keeps its place in line.
    void settled.then(() => {
      if (this.tails.get(streamKey) === settled) this.tails.delete(streamKey)
    })
    return delivery
  }

  /** Everything after dedup: materialise attachments, then notify. */
  private async deliver(msg: ParsedMessage, source: MessageSource, meta: Record<string, string>): Promise<void> {
    // A url in the content would be fetched as a web page and flattened to
    // text, so the session can only SEE an image if it has a file to read.
    // Downloading here (rather than at send time) is also what lets a session
    // that was offline receive the image whenever it comes back.
    const { text: content, saved } = await renderInboundText({
      text: msg.text,
      images: msg.images,
      ts: Date.parse(msg.ts) || Date.now(),
    })
    if (saved.length > 0) meta.images = String(saved.length)

    try {
      await this.mcp.notification({
        method: 'notifications/claude/channel',
        params: { content, meta },
      })
    } catch (err) {
      this.emit('notify:error', { msg, source, err })
      // RETHROW. The caller advances the session's read cursor over every row
      // whose push resolved, and that cursor is the only record of what has
      // been seen — so swallowing here acked a message the session was never
      // shown and buried it permanently. `notify:error` cannot substitute: it
      // has no listener in production code and this class has no logger, so a
      // swallowed failure is invisible at every layer. The queue is protected
      // separately in `push` (`tails` holds the caught promise), so rejecting
      // stops the ack without stalling the next message.
      throw err
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
