// Claude Code Collab Slack App - FlatOut Solutions workspace
export const SLACK_APP_ID = 'A0AT2SKA69Z'
export const SLACK_CLIENT_ID = '8752610368039.10920903346339'
export const SLACK_CLIENT_SECRET = '218468445052a9696ccea85d8a857d84'
export const SLACK_APP_TOKEN = 'xapp-1-A0AT2SKA69Z-10927298812130-61bbf9ab2e1698e1586f7f747e7bab0a8480631b9a6b46cba630fe6987c254fc'
export const OAUTH_REDIRECT_URI = 'http://localhost:9876/oauth/callback'
export const OAUTH_PORT = 9876
export const BROKER_PORT = 7850
export const BROKER_ID = process.env.BROKER_ID?.trim() || 'default'
export const BROKER_RENDEZVOUS_FILE = `/tmp/slack-collab-broker-${BROKER_ID}.json`
