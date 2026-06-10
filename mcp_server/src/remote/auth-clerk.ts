import { createHash, randomBytes } from 'node:crypto'
import { openBrowser } from './browser.js'
import { startLoopbackListener } from './loopback.js'

/**
 * Default loopback port for the Clerk OAuth callback. Clerk's Dashboard
 * rejects wildcards in redirect-URL port position (RFC 8252 §7.3 non-compliance),
 * so the redirect URL must be allowlisted with an exact port. Locations can
 * override via clerkRedirectPort if 53682 collides locally.
 */
export const DEFAULT_CLERK_REDIRECT_PORT = 53682

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

/**
 * Field names whose values must never appear in thrown error messages
 * or log output. Used by `redactSensitiveFields` before any malformed
 * token-endpoint response body is stringified into an error. A leaked
 * `access_token` here would otherwise propagate to user-visible logs
 * (the tool layer surfaces error.message back to the model and to
 * stderr).
 */
const SENSITIVE_RESPONSE_FIELDS: ReadonlySet<string> = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'code_verifier',
])

/**
 * Shallow-clone a record with sensitive field values replaced by a
 * placeholder. Only top-level keys are scrubbed because Clerk's OAuth
 * token endpoint returns flat JSON; nested scrubbing would be a
 * speculative generalization. If a malformed response embeds tokens
 * deeper (unexpected upstream change), the placeholder still makes the
 * leak obvious to the operator without exposing the secret.
 */
function redactSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_RESPONSE_FIELDS.has(k) ? '<redacted>' : v
  }
  return out
}

export interface AuthorizeUrlArgs {
  issuer: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  scopes?: string[]
}

/**
 * Constructs Clerk's /oauth/authorize URL per RFC 6749 §4.1.1 (Authorization Request)
 * with PKCE params per RFC 7636 §4.3. The default scopes `openid profile email`
 * are required: `openid` makes Clerk issue the OIDC ID token that authenticates
 * Convex (its `aud` is the OAuth Client ID, matching KAI's auth.config.ts
 * provider), and the profile/email claims back KAI's users lookup via clerkId.
 */
/**
 * Default OAuth scopes. `openid` makes Clerk issue the OIDC ID token used to
 * authenticate Convex; `profile email` back KAI's users lookup. The same set
 * is re-sent on refresh (RFC 6749 §6) so Clerk re-issues the `id_token`.
 */
export const DEFAULT_CLERK_SCOPES = ['openid', 'profile', 'email'] as const

export function buildAuthorizeUrl(args: AuthorizeUrlArgs): string {
  const url = new URL('/oauth/authorize', args.issuer)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', args.state)
  url.searchParams.set('scope', (args.scopes ?? DEFAULT_CLERK_SCOPES).join(' '))
  return url.toString()
}

/**
 * Decode a JWT's `exp` claim (seconds since epoch) without verifying the
 * signature — the server re-verifies on every request; this is only used
 * locally to decide whether a cached/fallback token is still worth keeping.
 * Returns null when the token is malformed or carries no numeric `exp`.
 */
export function decodeJwtExp(jwt: string): number | null {
  try {
    const payload = jwt.split('.')[1] ?? ''
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof parsed.exp === 'number' ? parsed.exp : null
  } catch {
    return null
  }
}

/**
 * True when a JWT is unusable as a still-valid credential: either it can't be
 * decoded (no readable `exp`) or its `exp` is in the past. Conservative by
 * design — an undecodable token is treated as expired so it never gets cached
 * or persisted as if live.
 */
function isJwtExpiredOrUndecodable(jwt: string): boolean {
  const exp = decodeJwtExp(jwt)
  if (exp === null) return true
  return exp * 1000 <= Date.now()
}

export interface TokenExchangeArgs {
  issuer: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /**
   * OIDC ID token (JWT) issued because the `openid` scope was granted. This
   * is the token used to authenticate Convex: its `aud` claim is the OAuth
   * Client ID, which KAI's auth.config.ts registers as a provider. The OAuth
   * access token carries no usable `aud` and cannot authenticate Convex, so
   * it is never sent there — only refreshed to keep the session alive.
   */
  idToken: string
  accessTokenExpiresAt: number
}

/**
 * Exchanges an authorization code for tokens via POST to /oauth/token per
 * RFC 6749 §4.1.3 (Access Token Request). Returns `accessTokenExpiresAt` as
 * an absolute timestamp (ms since epoch) so callers don't need to track
 * `expires_in` themselves. The `openid` scope guarantees an `id_token`.
 */
export async function exchangeCodeForTokens(
  args: TokenExchangeArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const url = new URL('/oauth/token', args.issuer)
  assertSecureBearerUrl(url, 'Clerk /oauth/token')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
  })
  const res = await fetchImpl(url.toString(), {
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
  const idToken = json.id_token
  const expiresIn = json.expires_in
  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof idToken !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new Error(`Unexpected token response shape: ${JSON.stringify(redactSensitiveFields(json))}`)
  }
  return {
    accessToken,
    refreshToken,
    idToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * Exchanges a refresh token for a new token set via POST to /oauth/token per
 * RFC 6749 §6 (Refreshing an Access Token). Preserves the prior refresh token
 * if Clerk omits one in the response — Clerk's docs are ambiguous about whether
 * rotation is always returned, so we fall back to the input. Likewise the
 * refresh grant normally re-issues an `id_token` (we re-send the `openid`
 * scope per RFC 6749 §6 so Clerk has no reason to omit it). `fallbackIdToken`
 * is a last resort for the case where Clerk omits it anyway — but it is only
 * honored when non-empty AND not yet expired, so a missing or stale ID token
 * surfaces as an error here (caller flips to unauthenticated) rather than
 * caching a dead/empty token that would fail every request until `exp`.
 */
export async function refreshAccessToken(
  args: { issuer: string; clientId: string; refreshToken: string; fallbackIdToken?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const url = new URL('/oauth/token', args.issuer)
  assertSecureBearerUrl(url, 'Clerk /oauth/token (refresh)')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    scope: DEFAULT_CLERK_SCOPES.join(' '),
  })
  const res = await fetchImpl(url.toString(), {
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
  const rawIdToken = json.id_token
  // Prefer a freshly-issued id_token; only fall back to the prior one when it
  // is a non-empty, not-yet-expired JWT. An empty or stale fallback is dropped
  // so the shape guard below throws instead of persisting a dead credential.
  let idToken: string | undefined
  if (typeof rawIdToken === 'string' && rawIdToken.length > 0) {
    idToken = rawIdToken
  } else if (
    typeof args.fallbackIdToken === 'string' &&
    args.fallbackIdToken.length > 0 &&
    !isJwtExpiredOrUndecodable(args.fallbackIdToken)
  ) {
    idToken = args.fallbackIdToken
  }
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || typeof idToken !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Unexpected refresh response shape: ${JSON.stringify(redactSensitiveFields(json))}`)
  }
  return {
    accessToken,
    refreshToken,
    idToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * True when sending a Bearer token to this hostname over plaintext HTTP
 * is acceptable. Only loopback addresses qualify — they never leave the
 * machine, so plaintext is fine for `convex dev` / self-hosted-on-laptop
 * setups and the test suite. Every other host (including LAN / VPN
 * addresses) MUST use HTTPS or this code will refuse to attach the
 * token.
 */
function isLoopbackHost(hostname: string): boolean {
  // Node's WHATWG URL preserves IPv6 brackets on `.hostname`, so a
  // literal `http://[::1]:8001` surfaces as `[::1]` here. Accept both
  // bracketed and bare forms to stay robust to that representation.
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/**
 * Refuse to send a Bearer token over a plaintext scheme. Loopback hosts
 * are allowed (local dev + tests). Anywhere else, mis-typed `http://`
 * URLs in a user's config would otherwise leak the OAuth access token
 * across the network.
 */
export function assertSecureBearerUrl(url: URL, context: string): void {
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return
  throw new Error(
    `Refusing to send Bearer token to a non-HTTPS endpoint (${context}: ${url.protocol}//${url.hostname}). ` +
      `Set the location URL to https:// or use a loopback host for local dev.`,
  )
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
      },
      args.fetchImpl,
    )
  } finally {
    listener.shutdown()
  }
}
