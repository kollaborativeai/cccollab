/**
 * Optional bridge that forwards new messages from the hosted Convex backend
 * into the local broker's /local-event SSE stream. This lets a Claude Code
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
}

export type TopicContext = {
  topicName: string
  channel: string
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
 * Pure transformer: given a Convex `messages` row and the topic/channel
 * it belongs to, produce the payload the local broker expects on its
 * POST /local-event endpoint.
 */
export function buildLocalEventPayload(row: ConvexMessageRow, ctx: TopicContext): LocalEventPayload {
  return {
    type: 'message',
    channel: ctx.channel,
    topicId: row.topicId,
    topicName: ctx.topicName,
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
}

export interface BridgeHandle {
  stop(): Promise<void>
}

/**
 * Forward a single message row to the broker. Exported so callers/tests can
 * drive the bridge without a live Convex subscription.
 */
export async function forwardRowToBroker(
  row: ConvexMessageRow,
  ctx: TopicContext,
  opts: { brokerUrl: string; fetch?: typeof fetch },
): Promise<void> {
  const payload = buildLocalEventPayload(row, ctx)
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
 * Start a reactive subscription to Convex messages and forward them to the broker.
 * The Convex client is lazily imported so this file can be used from test code
 * without requiring the Convex client at import time.
 */
export async function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const { ConvexClient } = await import('convex/browser')
  const client = new ConvexClient(opts.convexUrl)
  if (opts.accessToken) {
    const token = opts.accessToken
    client.setAuth(async () => token)
  }
  const seen = new Set<string>()
  const unsubscribe = client.onUpdate(
    'messages:listRecent' as unknown as Parameters<typeof client.onUpdate>[0],
    {} as Parameters<typeof client.onUpdate>[1],
    async (rows: ConvexMessageRow[]) => {
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (seen.has(row._id)) continue
        seen.add(row._id)
        await forwardRowToBroker(
          row,
          { topicName: row.topicId, channel: 'external' },
          { brokerUrl: opts.brokerUrl, fetch: opts.fetch },
        )
      }
    },
  )
  return {
    async stop() {
      unsubscribe()
      await client.close()
    },
  }
}
