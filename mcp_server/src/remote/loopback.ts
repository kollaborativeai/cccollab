import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Shared HTTP loopback listener for OAuth/PKCE callbacks. The Clerk PKCE
 * flow (`remote/auth-clerk.ts`) opens the system browser at the Clerk
 * authorization endpoint and waits for the redirect to land back at
 * `http://127.0.0.1:<port>${OAUTH_CALLBACK_PATH}`.
 *
 * The redirect URL allowlisted in the Clerk dashboard must point at this
 * exact path. See `docs/architecture/clerk-auth-setup.md`.
 */
export const OAUTH_CALLBACK_PATH = '/cccollab-oauth-callback'

export interface LoopbackCallback {
  code: string
  state: string | null
}

export interface LoopbackListener {
  port: number
  waitForCallback(): Promise<LoopbackCallback>
  shutdown(): void
}

export async function startLoopbackListener(timeoutMs: number, listenPort?: number): Promise<LoopbackListener> {
  // Deferred promise settled once by the FIRST event: either a valid
  // callback arrives or the timeout fires. Eagerly created so the
  // listener can receive a callback BEFORE `waitForCallback()` is awaited
  // (the browser can race ahead of the caller).
  let settle: (
    value: { kind: 'callback'; callback: LoopbackCallback } | { kind: 'error'; err: Error },
  ) => void = () => {}
  const settled: Promise<{ kind: 'callback'; callback: LoopbackCallback } | { kind: 'error'; err: Error }> =
    new Promise((resolve) => {
      settle = resolve
    })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code === '') {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('missing code')
      settle({ kind: 'error', err: new Error('OAuth callback missing code parameter') })
      return
    }
    const state = url.searchParams.get('state')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>cccollab</title></head><body style="font-family:system-ui;padding:3em;text-align:center;"><h1>You're signed in.</h1><p>You can close this tab and return to your terminal.</p></body></html>`,
    )
    settle({ kind: 'callback', callback: { code, state } })
  })

  const port: number = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort ?? 0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(addr.port)
    })
  })

  const timeoutHandle = setTimeout(() => {
    settle({ kind: 'error', err: new Error(`Timed out waiting for OAuth callback after ${timeoutMs}ms`) })
  }, timeoutMs)
  timeoutHandle.unref?.()

  return {
    port,
    waitForCallback: async () => {
      const result = await settled
      clearTimeout(timeoutHandle)
      // Close the server off-tick so an in-flight 200 response has a
      // chance to flush to the browser.
      setImmediate(() => server.close())
      if (result.kind === 'error') throw result.err
      return result.callback
    },
    shutdown: () => {
      clearTimeout(timeoutHandle)
      server.close()
    },
  }
}
