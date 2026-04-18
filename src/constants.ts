// CCCollab Slack App - FlatOut Solutions workspace
export const SLACK_APP_ID = 'A0AT2SKA69Z'
export const SLACK_CLIENT_ID = '8752610368039.10920903346339'
export const SLACK_CLIENT_SECRET = '2b7556073f3e69ea349c12ecc26b768b'
export const SLACK_APP_TOKEN = 'xapp-1-A0AT2SKA69Z-10936950471347-34a88b560c572234c890eafa65a405b653642b438c4c57128c64b0458fbaa269'
export const OAUTH_REDIRECT_URI = 'http://localhost:9876/oauth/callback'
export const OAUTH_PORT = 9876
export const BROKER_PORT = 7850
export const BROKER_ID = process.env.BROKER_ID?.trim() || 'default'
export const BROKER_RENDEZVOUS_FILE = `/tmp/cccollab-broker-${BROKER_ID}.json`
