/**
 * Optional bridge that forwards new messages from the hosted Convex backend
 * into the local broker's `/local-event` SSE stream. This lets a Claude Code
 * session receive messages sent by external AI clients (via the HTTP MCP
 * server) in real time, without requiring the plugin itself to talk to Convex
 * directly. Opt-in via the `CCCOLLAB_CONVEX_URL` env var.
 */

export type ConvexMessageRow = {
  _id: string
  _creationTime: number
  topicId: string
  authorType: 'session' | 'external'
  authorKey: string
  authorName: string
  text: string
  /** Human-readable topic name (hydrated by `convex.messages.listRecent`). */
  topicName: string
  /** Parent channel name (hydrated by `convex.messages.listRecent`). */
  channelName: string
}

export type LocalEventPayload = {
  type: 'message'
  channel: string
  topicId: string
  topicName: string
  sender: string
  authorType: 'session' | 'external'
  text: string
  ts: string
}

/**
 * Pure transformer: given a hydrated Convex message row, produce the payload
 * the local broker expects on its `POST /local-event` endpoint. The topic's
 * human-readable name and parent channel name are taken from the hydrated row
 * (so the broker routes correctly rather than labelling everything as a magic
 * `external` channel).
 */
export function buildLocalEventPayload(row: ConvexMessageRow): LocalEventPayload {
  return {
    type: 'message',
    channel: row.channelName,
    topicId: row.topicId,
    topicName: row.topicName,
    sender: row.authorName,
    authorType: row.authorType,
    text: row.text,
    ts: new Date(row._creationTime).toISOString(),
  }
}

export interface BridgeOptions {
  convexUrl: string
  brokerUrl: string
  /** Bearer token for authenticating to Convex (if exposed over HTTP auth). */
  accessToken?: string
  /** Override fetch (for tests). */
  fetch?: typeof fetch
  /** Max size of the dedup set; older IDs are evicted FIFO. */
  seenCapacity?: number
}

export interface BridgeHandle {
  stop(): Promise<void>
}

const DEFAULT_SEEN_CAPACITY = 10_000

/** Forward a single hydrated message row to the broker. */
export async function forwardRowToBroker(
  row: ConvexMessageRow,
  opts: { brokerUrl: string; fetch?: typeof fetch },
): Promise<void> {
  const payload = buildLocalEventPayload(row)
  const f = opts.fetch ?? fetch
  await f(`${opts.brokerUrl}/local-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    /* best-effort: broker may be down */
  })
}

/**
 * FIFO-bounded set: remembers insertion order and evicts the oldest entry
 * once `capacity` is exceeded. This bounds memory in long-running bridge
 * processes instead of letting the `seen` set grow without limit.
 */
class BoundedSet {
  private readonly items = new Set<string>()
  private readonly order: string[] = []
  constructor(private readonly capacity: number) {}
  has(id: string): boolean {
    return this.items.has(id)
  }
  add(id: string): void {
    if (this.items.has(id)) return
    this.items.add(id)
    this.order.push(id)
    while (this.order.length > this.capacity) {
      const evicted = this.order.shift()
      if (evicted !== undefined) this.items.delete(evicted)
    }
  }
}

/**
 * Start a reactive subscription to Convex messages and forward them to the
 * broker. The Convex client is lazily imported so this file can be consumed
 * from test code without needing the Convex browser client at import time.
 */
export async function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const { ConvexClient } = await import('convex/browser')
  const { makeFunctionReference } = await import('convex/server')
  const listRecentRef = makeFunctionReference<'query', Record<string, never>, ConvexMessageRow[]>('messages:listRecent')

  const client = new ConvexClient(opts.convexUrl)
  if (opts.accessToken) {
    const token = opts.accessToken
    client.setAuth(async () => token)
  }
  const seen = new BoundedSet(opts.seenCapacity ?? DEFAULT_SEEN_CAPACITY)
  const unsubscribe = client.onUpdate(listRecentRef, {}, async (rowsRaw) => {
    const rows = rowsRaw as ConvexMessageRow[]
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (seen.has(row._id)) continue
      seen.add(row._id)
      await forwardRowToBroker(row, { brokerUrl: opts.brokerUrl, fetch: opts.fetch })
    }
  })
  return {
    async stop() {
      unsubscribe()
      await client.close()
    },
  }
}
