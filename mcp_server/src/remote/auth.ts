import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConvexHttpClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { anyApi } from 'convex/server'

import { openBrowser } from './browser.js'
import { saveLocationAuth } from '../config/save.js'

// The remote mcp_server code compiles without a local reference to
// `convex/_generated`, so we use `anyApi` (runtime-typed) for the auth
// entrypoint and cast to the `action` FunctionReference that
// `ConvexHttpClient.action` expects.
//
// Rationale: the _generated directory is gitignored and specific to
// the Convex deployment being targeted. Shipping an npm package that
// embeds it would bake a deploy-time coupling; runtime-typing is the
// Convex idiom for library / tooling code that calls into a
// user-supplied deployment.
const SIGNIN_ACTION = (anyApi as { auth: { signIn: unknown } }).auth.signIn as FunctionReference<'action'>

/**
 * The loopback callback path must match the `isAllowedRedirect` rule on
 * the Convex side (`convex/redirect.ts`). Any change here requires a
 * matching change there.
 */
const OAUTH_CALLBACK_PATH = '/cccollab-oauth-callback'

/**
 * Shape of the Convex Auth `signIn` action response. Modelled on the
 * declaration in `@convex-dev/auth`'s `convexAuth({})` result. The
 * action may return any of these fields depending on which stage of
 * the flow we're in.
 */
interface SignInResult {
  redirect?: string
  verifier?: string
  tokens?: { token: string; refreshToken: string } | null
  started?: boolean
}

/**
 * Result of a successful `authenticate` flow. The tokens have already
 * been persisted to `~/.cccollab/config.json` under the named location
 * with mode `0600`; this return is a summary so the caller can report
 * back.
 */
export interface AuthenticateResult {
  locationName: string
  url: string
  userId?: string
  userEmail?: string
}

interface AuthenticateOptions {
  /** The location name the new tokens should be saved under in the
   *  user-level config. */
  locationName: string
  /** Convex deployment URL for the location. */
  url: string
  /** Called with the user-facing message printed BEFORE the browser
   *  opens. Tests inject a collector instead of stderr. */
  log?: (message: string) => void
  /** Override the browser opener for tests. */
  openUrl?: (url: string) => Promise<void>
  /** Override the fetch used to call the Convex action; tests pass a
   *  mock client. Production path uses a freshly constructed
   *  `ConvexHttpClient` against `url`. */
  httpClient?: Pick<ConvexHttpClient, 'action'>
  /** Hard cap on how long we wait for the browser redirect. */
  timeoutMs?: number
}

/**
 * Run the Convex Auth "Google" OAuth flow from this Node process
 * against a single named location. See the module-level JSDoc of the
 * prior single-location variant for protocol details; the only
 * difference from that version is that tokens are persisted via
 * `saveLocationAuth(locationName, ...)` so one user-level file can
 * hold credentials for multiple locations side by side.
 */
export async function runAuthenticate(options: AuthenticateOptions): Promise<AuthenticateResult> {
  const log = options.log ?? ((m) => process.stderr.write(`[cccollab] ${m}\n`))
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  const client = options.httpClient ?? new ConvexHttpClient(options.url)
  const openUrl = options.openUrl ?? openBrowser

  const listener = await startLoopbackListener(timeoutMs)
  const redirectTo = `http://127.0.0.1:${listener.port}${OAUTH_CALLBACK_PATH}`

  let first: SignInResult
  try {
    first = (await client.action(SIGNIN_ACTION, {
      provider: 'google',
      params: { redirectTo },
      calledBy: 'cccollab-mcp-server',
    })) as SignInResult
  } catch (err) {
    listener.shutdown()
    throw new Error(`Could not start Convex sign-in: ${(err as Error).message}`, { cause: err })
  }

  if (first.redirect === undefined || first.verifier === undefined) {
    listener.shutdown()
    throw new Error(`Unexpected signIn response (no redirect / verifier): ${JSON.stringify(first)}`)
  }

  log(`Opening your browser to complete sign-in...`)
  log(`If the browser does not open, paste this URL manually:`)
  log(`  ${first.redirect}`)

  try {
    await openUrl(first.redirect)
  } catch {
    // openBrowser() rejected - we still proceed; the user can copy
    // the URL manually. No retry loop; the listener's timeout will
    // abort if the user gives up.
  }

  const code = await listener.waitForCode()

  let second: SignInResult
  try {
    second = (await client.action(SIGNIN_ACTION, {
      provider: 'google',
      params: { code },
      verifier: first.verifier,
      calledBy: 'cccollab-mcp-server',
    })) as SignInResult
  } catch (err) {
    throw new Error(`Could not exchange OAuth code for tokens: ${(err as Error).message}`, { cause: err })
  }

  if (!second.tokens || !second.tokens.token || !second.tokens.refreshToken) {
    throw new Error('Convex signIn did not return tokens')
  }

  saveLocationAuth(options.locationName, {
    url: options.url,
    accessToken: second.tokens.token,
    refreshToken: second.tokens.refreshToken,
    updatedAt: Date.now(),
  })

  log(`Signed in. Remote transport for "${options.locationName}" is now available.`)
  return {
    locationName: options.locationName,
    url: options.url,
  }
}

interface LoopbackListener {
  port: number
  waitForCode(): Promise<string>
  shutdown(): void
}

async function startLoopbackListener(timeoutMs: number): Promise<LoopbackListener> {
  // Deferred promise settled once by the FIRST event: either a valid
  // callback arrives or the timeout fires. Eagerly created so the
  // listener can receive a callback BEFORE `waitForCode()` is awaited
  // (the browser can race ahead of the caller).
  let settle: (value: { kind: 'code'; code: string } | { kind: 'error'; err: Error }) => void = () => {}
  const settled: Promise<{ kind: 'code'; code: string } | { kind: 'error'; err: Error }> = new Promise((resolve) => {
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>cccollab</title></head><body style="font-family:system-ui;padding:3em;text-align:center;"><h1>You're signed in.</h1><p>You can close this tab and return to your terminal.</p></body></html>`,
    )
    settle({ kind: 'code', code })
  })

  const port: number = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
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
    waitForCode: async () => {
      const result = await settled
      clearTimeout(timeoutHandle)
      // Close the server off-tick so an in-flight 200 response has a
      // chance to flush to the browser.
      setImmediate(() => server.close())
      if (result.kind === 'error') throw result.err
      return result.code
    },
    shutdown: () => {
      clearTimeout(timeoutHandle)
      server.close()
    },
  }
}
