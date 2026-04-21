#!/usr/bin/env node
/**
 * CLI entry point for the Convex->broker bridge. Run this on any machine that
 * has a local cccollab broker, pointed at a Convex deployment, to receive
 * messages from external MCP clients as broker `/local-event` push.
 *
 * Env:
 *   CCCOLLAB_CONVEX_URL    (required) e.g. https://<deployment>.convex.cloud
 *   CCCOLLAB_BROKER_URL    (required) e.g. http://127.0.0.1:<port>
 *   CCCOLLAB_CONVEX_TOKEN  (optional) bearer for authenticated Convex queries
 */

import { startBridge } from './convex-bridge.js'

async function main(): Promise<void> {
  const convexUrl = process.env.CCCOLLAB_CONVEX_URL
  const brokerUrl = process.env.CCCOLLAB_BROKER_URL
  const accessToken = process.env.CCCOLLAB_CONVEX_TOKEN
  if (!convexUrl) {
    console.error('CCCOLLAB_CONVEX_URL is required')
    process.exit(1)
  }
  if (!brokerUrl) {
    console.error('CCCOLLAB_BROKER_URL is required')
    process.exit(1)
  }
  const handle = await startBridge({ convexUrl, brokerUrl, accessToken })
  console.error(`[cccollab-bridge] subscribing to ${convexUrl}; forwarding to ${brokerUrl}`)

  const shutdown = async (signal: string): Promise<never> => {
    console.error(`[cccollab-bridge] received ${signal}; stopping...`)
    await handle.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
}

main().catch((err) => {
  console.error('[cccollab-bridge] fatal:', err)
  process.exit(1)
})
