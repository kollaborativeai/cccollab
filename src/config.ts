import { loadCredentials } from './credentials.js'
import { SLACK_APP_TOKEN } from './constants.js'

export interface Config {
  slackBotToken: string
  slackAppToken: string
  slackUserToken: string
  username: string
  defaultChannel: string | undefined
  authenticated: true
}

export interface UnauthenticatedConfig {
  authenticated: false
}

export type AppConfig = Config | UnauthenticatedConfig

export function loadConfig(): AppConfig {
  const creds = loadCredentials()

  if (!creds) {
    return { authenticated: false }
  }

  const defaultChannelRaw = process.env.DEFAULT_SLACK_CHANNEL?.trim()
  const defaultChannel = defaultChannelRaw ? defaultChannelRaw.replace(/^#/, '') : undefined

  return {
    slackBotToken: creds.botToken,
    slackAppToken: SLACK_APP_TOKEN,
    slackUserToken: creds.userToken,
    username: creds.userName,
    defaultChannel,
    authenticated: true,
  }
}
