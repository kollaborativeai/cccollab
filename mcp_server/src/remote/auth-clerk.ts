import { createHash, randomBytes } from 'node:crypto'
import { openBrowser } from './browser.js'
import { startLoopbackListener } from './auth.js'

/**
 * Default loopback port for the Clerk OAuth callback. Clerk's Dashboard
 * rejects wildcards in redirect-URL port position (RFC 8252 §7.3 non-compliance),
 * so the redirect URL must be allowlisted with an exact port. Locations can
 * override via clerkRedirectPort if 53682 collides locally.
 */
export const DEFAULT_CLERK_REDIRECT_PORT = 53682

/**
 * OAuth audience requested when the target is a Convex deployment. Matches
 * KAI's `auth.config.ts` `applicationID: 'convex'` — Convex's JWT verification
 * requires `aud === 'convex'`.
 *
 * Threaded as the `resource` parameter (RFC 8707, Resource Indicators for
 * OAuth 2.0) on both /oauth/authorize and /oauth/token requests so Clerk
 * mints the access-token JWT with this audience. Without it Clerk's OAuth
 * access tokens omit `aud` entirely and Convex rejects every request.
 */
export const CLERK_CONVEX_AUDIENCE = 'convex'

/**
 * Generate a cryptographically-random PKCE code verifier per RFC 7636 §4.1.
 * 64 bytes of randomness → 86-char base64url string (well within the 43-128
 * char limit).
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(64))
}

/**
 * Derive the S256 code challenge for a given verifier (RFC 7636 §4.2).
 */
export function deriveCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest())
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface AuthorizeUrlArgs {
  issuer: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  scopes?: string[]
  /** Resource indicator (RFC 8707). When set, Clerk includes this value as
   *  the `aud` claim on the issued access token JWT. Required for Convex
   *  targets — see CLERK_CONVEX_AUDIENCE. */
  resource?: string
}

/**
 * Constructs Clerk's /oauth/authorize URL per RFC 6749 §4.1.1 (Authorization Request)
 * with PKCE params per RFC 7636 §4.3. Default scopes `openid profile email` are the
 * minimum needed for KAI's users lookup via clerkId.
 */
export function buildAuthorizeUrl(args: AuthorizeUrlArgs): string {
  const url = new URL('/oauth/authorize', args.issuer)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', args.state)
  url.searchParams.set('scope', (args.scopes ?? ['openid', 'profile', 'email']).join(' '))
  if (args.resource !== undefined) url.searchParams.set('resource', args.resource)
  return url.toString()
}

export interface TokenExchangeArgs {
  issuer: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
  /** Resource indicator (RFC 8707). Must match the value passed to
   *  buildAuthorizeUrl so Clerk's issued JWT carries the expected `aud`. */
  resource?: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: number
}

/**
 * Exchanges an authorization code for tokens via POST to /oauth/token per
 * RFC 6749 §4.1.3 (Access Token Request). Returns `accessTokenExpiresAt` as
 * an absolute timestamp (ms since epoch) so callers don't need to track
 * `expires_in` themselves.
 */
export async function exchangeCodeForTokens(
  args: TokenExchangeArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const url = new URL('/oauth/token', args.issuer).toString()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
  })
  if (args.resource !== undefined) body.set('resource', args.resource)
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const errorCode = typeof json.error === 'string' ? json.error : 'token_exchange_failed'
    throw new Error(`Clerk token exchange failed: ${errorCode}`)
  }
  const accessToken = json.access_token
  const refreshToken = json.refresh_token
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Unexpected token response shape: ${JSON.stringify(json)}`)
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * Exchanges a refresh token for a new token set via POST to /oauth/token per
 * RFC 6749 §6 (Refreshing an Access Token). Preserves the prior refresh token
 * if Clerk omits one in the response — Clerk's docs are ambiguous about whether
 * rotation is always returned, so we fall back to the input.
 */
export async function refreshAccessToken(
  args: { issuer: string; clientId: string; refreshToken: string; resource?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const url = new URL('/oauth/token', args.issuer).toString()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  })
  if (args.resource !== undefined) body.set('resource', args.resource)
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const errorCode = typeof json.error === 'string' ? json.error : 'refresh_failed'
    throw new Error(`Clerk refresh failed: ${errorCode}`)
  }
  const accessToken = json.access_token
  const rawRefresh = json.refresh_token
  const refreshToken = typeof rawRefresh === 'string' && rawRefresh.length > 0 ? rawRefresh : args.refreshToken
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Unexpected refresh response shape: ${JSON.stringify(json)}`)
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
  }
}

export interface RunClerkPkceArgs {
  issuer: string
  clientId: string
  scopes?: string[]
  timeoutMs?: number
  /** Override the loopback port for the OAuth callback. Defaults to
   *  DEFAULT_CLERK_REDIRECT_PORT (53682). Must match an exact URL
   *  allowlisted in Clerk Dashboard — Clerk rejects wildcards in the
   *  port position (RFC 8252 §7.3 non-compliance). */
  redirectPort?: number
  /** Resource indicator (RFC 8707). Threaded into both the authorize
   *  redirect and the token exchange so Clerk's access-token JWT carries
   *  this as its `aud` claim. For Convex targets, set to
   *  CLERK_CONVEX_AUDIENCE. */
  resource?: string
  /** Test hook: called with the authorize URL instead of opening the browser. */
  onAuthorizeUrl?: (url: string) => void
  /** Test hook: inject a fetch implementation. */
  fetchImpl?: typeof fetch
  /** Test hook: inject a loopback listener factory. */
  startListenerImpl?: typeof startLoopbackListener
}

/**
 * Drive a full OAuth 2.0 Authorization Code + PKCE flow against Clerk:
 * generate verifier+challenge, open the user's browser to Clerk's
 * /oauth/authorize, capture the callback on a loopback listener,
 * verify state matches, and exchange the code for a TokenSet.
 *
 * Reuses the cccollab loopback listener (mcp_server/src/remote/auth.ts)
 * and the platform-minimal browser opener
 * (mcp_server/src/remote/browser.ts). RFC 6749 §4.1 + RFC 7636.
 */
export async function runClerkPkce(args: RunClerkPkceArgs): Promise<TokenSet> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = deriveCodeChallenge(codeVerifier)
  const state = generateCodeVerifier().slice(0, 32)
  const timeoutMs = args.timeoutMs ?? 5 * 60 * 1000

  const redirectPort = args.redirectPort ?? DEFAULT_CLERK_REDIRECT_PORT
  const startListener = args.startListenerImpl ?? startLoopbackListener
  const listener = await startListener(timeoutMs, redirectPort)

  try {
    const redirectUri = `http://127.0.0.1:${listener.port}/cccollab-oauth-callback`
    const authorizeUrl = buildAuthorizeUrl({
      issuer: args.issuer,
      clientId: args.clientId,
      redirectUri,
      codeChallenge,
      state,
      scopes: args.scopes,
      resource: args.resource,
    })

    if (args.onAuthorizeUrl) {
      args.onAuthorizeUrl(authorizeUrl)
    } else {
      await openBrowser(authorizeUrl)
    }

    const callback = await listener.waitForCallback()
    if (callback.state !== state) {
      throw new Error(`OAuth state mismatch: expected ${state}, got ${callback.state ?? '(missing)'}`)
    }

    return await exchangeCodeForTokens(
      {
        issuer: args.issuer,
        clientId: args.clientId,
        redirectUri,
        code: callback.code,
        codeVerifier,
        resource: args.resource,
      },
      args.fetchImpl,
    )
  } finally {
    listener.shutdown()
  }
}
