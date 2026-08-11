export interface ParsedMessage {
  sender: string
  text: string
  ts: string
  channel: string
  channelName: string | undefined
  threadTs: string | undefined
  /** Human-readable name of the topic `threadTs` refers to. Present on local
   *  broker topic traffic so a channel watcher, which never joined the topic
   *  and so has no local name for its id, still sees what it is reading.
   *  Remote transports do not set this field today. */
  topicName?: string
}
