export const BROKER_ID = process.env.BROKER_ID?.trim() || 'default'
export const BROKER_RENDEZVOUS_FILE = `/tmp/cccollab-broker-${BROKER_ID}.json`
