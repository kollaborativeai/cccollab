export interface Config {
  slackBotToken: string
  slackAppToken: string
  username: string
  sessionRole: string | undefined
  registryChannel: string
}

export interface ParsedMessage {
  sender: string
  text: string
  ts: string
  channel: string
  channelName: string | undefined
  threadTs: string | undefined
}
