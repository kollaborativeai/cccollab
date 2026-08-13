export interface ParsedMessage {
  sender: string
  text: string
  ts: string
  channel: string
  channelName: string | undefined
  threadTs: string | undefined
  /** Set to `'dm'` for a private 1:1 message (KAI-514) so `MessageBus`
   *  can tag the outbound notification distinctly from a channel/topic
   *  message instead of surfacing a fake channel name. Omitted (channel
   *  message) otherwise. */
  kind?: 'dm'
}
