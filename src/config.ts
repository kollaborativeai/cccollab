import { loadCredentials } from './credentials.js'
import { SLACK_APP_TOKEN, REGISTRY_CHANNEL, BROKER_PORT } from './constants.js'

export interface Config {
  slackBotToken: string
  slackAppToken: string
  slackUserToken: string
  username: string
  registryChannel: string
  brokerPort: number
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

  return {
    slackBotToken: creds.botToken,
    slackAppToken: SLACK_APP_TOKEN,
    slackUserToken: creds.userToken,
    username: creds.userName,
    registryChannel: REGISTRY_CHANNEL,
    brokerPort: BROKER_PORT,
    authenticated: true,
  }
}
