import { loadCredentials } from './credentials.js'
import { SLACK_APP_TOKEN, BROKER_PORT } from './constants.js'

export interface Config {
  slackBotToken: string
  slackAppToken: string
  slackUserToken: string
  username: string
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
    brokerPort: BROKER_PORT,
    authenticated: true,
  }
}
