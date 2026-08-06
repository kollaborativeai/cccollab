/**
 * An image attachment as announced by the backend. Metadata only — the bytes
 * are fetched on delivery (see `attachments.ts`), so a session that was offline
 * when the message was sent still gets the file when it catches up.
 */
export interface InboundImage {
  name: string
  /** Download url. Treated as untrusted input: scheme-checked before any fetch. */
  url: string
  mimeType: string
  /** Size as claimed by the sender. The downloaded body is what actually gates. */
  size: number
}

export interface ParsedMessage {
  sender: string
  text: string
  ts: string
  channel: string
  channelName: string | undefined
  threadTs: string | undefined
  images?: InboundImage[]
}
