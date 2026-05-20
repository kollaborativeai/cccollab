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
  // KAI's exchangeToken response shape — `jwt` is short-lived but still a
  // capability token while it's valid.
  'jwt',
])

/**
 * Shallow-clone a record with sensitive field values replaced by a
 * placeholder. Only top-level keys are scrubbed because Clerk and KAI
 * OAuth endpoints return flat JSON; nested scrubbing would be a
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
  const url = new URL('/oauth/token', args.issuer)
  assertSecureBearerUrl(url, 'Clerk /oauth/token')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
  })
  if (args.resource !== undefined) body.set('resource', args.resource)
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
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Unexpected token response shape: ${JSON.stringify(redactSensitiveFields(json))}`)
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
  const url = new URL('/oauth/token', args.issuer)
  assertSecureBearerUrl(url, 'Clerk /oauth/token (refresh)')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  })
  if (args.resource !== undefined) body.set('resource', args.resource)
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
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Unexpected refresh response shape: ${JSON.stringify(redactSensitiveFields(json))}`)
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
  }
}

/**
 * Discriminated error codes from KAI's /cccollab/exchangeToken endpoint.
 *
 * Retry semantics per code:
 *  - INVALID_OAUTH_TOKEN → fetcher force-refreshes OAuth and retries
 *    exchange once.
 *  - UPSTREAM_RATE_LIMITED, UPSTREAM_UNAVAILABLE → transient Clerk-side
 *    issues; intended to be retryable with backoff. Currently surfaced
 *    through the fetcher as null (terminal) until empirical smoke
 *    testing motivates a retry layer — user re-runs the MCP tool to
 *    recover.
 *  - All other codes → terminal. The 500-level codes signal
 *    misconfiguration or Clerk-API-contract regressions the CLI cannot
 *    self-heal from.
 */
export type ConvexJwtExchangeErrorCode =
  | 'MISSING_AUTH_HEADER'
  | 'INVALID_OAUTH_TOKEN'
  | 'MISSING_SESSION'
  | 'NO_ACTIVE_SESSION'
  | 'SESSION_NOT_FOUND'
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_RESPONSE_INVALID'
  | 'SERVER_MISCONFIGURED'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'EXCHANGE_FAILED'

/** All ConvexJwtExchangeErrorCode values for runtime narrowing. */
const KNOWN_EXCHANGE_ERROR_CODES: readonly ConvexJwtExchangeErrorCode[] = [
  'MISSING_AUTH_HEADER',
  'INVALID_OAUTH_TOKEN',
  'MISSING_SESSION',
  'NO_ACTIVE_SESSION',
  'SESSION_NOT_FOUND',
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_RESPONSE_INVALID',
  'SERVER_MISCONFIGURED',
  'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'EXCHANGE_FAILED',
]

/**
 * Thrown by exchangeOAuthTokenForConvexJwt when KAI's endpoint returns an
 * error. `code` is the structured error code from KAI's response body so
 * callers can branch on the specific failure (e.g. retry after OAuth
 * refresh on INVALID_OAUTH_TOKEN).
 */
export class ConvexJwtExchangeError extends Error {
  constructor(
    public readonly code: ConvexJwtExchangeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ConvexJwtExchangeError'
  }
}

export interface ExchangeOAuthTokenArgs {
  /** KAI Convex deployment URL (the `url` field on the clerk location). */
  kaiUrl: string
  /** The OAuth access token JWT minted by Clerk's /oauth/token endpoint. */
  oauthToken: string
}

export interface ConvexJwtResult {
  jwt: string
  /** Epoch ms at which the templated JWT expires. */
  expiresAt: number
}

/**
 * Translate a Convex deployment URL into its HTTP-action base URL.
 *
 * Convex serves the SDK/WebSocket API at `<slug>.convex.cloud` and HTTP
 * actions (registered via `httpRouter`) at the sibling hostname
 * `<slug>.convex.site`. The two share a deployment but are routed on
 * different domains to avoid path collisions between user-defined HTTP
 * action paths and Convex's own SDK API paths.
 *
 * For any URL with a `.convex.cloud` hostname suffix, this returns the
 * same URL with that suffix swapped for `.convex.site`. Other URLs pass
 * through unchanged (covers self-hosted deployments and tests that use
 * arbitrary hostnames).
 */
export function deploymentUrlToHttpActionUrl(deploymentUrl: string): string {
  const u = new URL(deploymentUrl)
  if (u.hostname.endsWith('.convex.cloud')) {
    u.hostname = u.hostname.slice(0, -'.convex.cloud'.length) + '.convex.site'
  }
  return u.toString().replace(/\/$/, '')
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
function assertSecureBearerUrl(url: URL, context: string): void {
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return
  throw new Error(
    `Refusing to send Bearer token to a non-HTTPS endpoint (${context}: ${url.protocol}//${url.hostname}). ` +
      `Set the location URL to https:// or use a loopback host for local dev.`,
  )
}

/**
 * Exchange a Clerk-issued OAuth access token for a Convex-audience JWT via
 * KAI's /cccollab/exchangeToken HTTP action. KAI uses CLERK_SECRET_KEY +
 * Clerk Backend SDK to mint a JWT with `aud: 'convex'` matching the
 * deployment's auth.config.ts applicationID.
 *
 * Why this exists: Clerk OAuth Application JWTs don't carry `aud` and
 * Clerk doesn't honor RFC 8707 `resource` indicator on this plan, so the
 * OAuth token alone cannot authenticate Convex calls. The exchange is the
 * minimal hop that bridges OAuth → templated-JWT semantics.
 *
 * URL routing: HTTP actions on a Convex deployment are served at
 * `<slug>.convex.site` rather than `<slug>.convex.cloud` (where the SDK
 * lives). We translate via deploymentUrlToHttpActionUrl before joining
 * the action path.
 *
 * @throws {ConvexJwtExchangeError} on 401 with a structured code.
 * @throws {Error} on network errors or unexpected response shape.
 */
export async function exchangeOAuthTokenForConvexJwt(
  args: ExchangeOAuthTokenArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<ConvexJwtResult> {
  const httpActionBase = deploymentUrlToHttpActionUrl(args.kaiUrl)
  const url = new URL('/cccollab/exchangeToken', httpActionBase)
  assertSecureBearerUrl(url, '/cccollab/exchangeToken')
  const res = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.oauthToken}`,
    },
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const rawCode = typeof json.code === 'string' ? json.code : 'EXCHANGE_FAILED'
    const code: ConvexJwtExchangeErrorCode = (KNOWN_EXCHANGE_ERROR_CODES as readonly string[]).includes(rawCode)
      ? (rawCode as ConvexJwtExchangeErrorCode)
      : 'EXCHANGE_FAILED'
    const message = typeof json.message === 'string' ? json.message : `Convex JWT exchange failed (${res.status})`
    throw new ConvexJwtExchangeError(code, message)
  }
  const jwt = json.jwt
  const expiresAt = json.expiresAt
  if (typeof jwt !== 'string' || typeof expiresAt !== 'number') {
    throw new Error(`Unexpected /cccollab/exchangeToken response shape: ${JSON.stringify(redactSensitiveFields(json))}`)
  }
  return { jwt, expiresAt }
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
