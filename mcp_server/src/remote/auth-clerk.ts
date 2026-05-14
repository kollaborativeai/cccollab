import { createHash, randomBytes } from 'node:crypto'

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
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
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
  return url.toString()
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
  args: { issuer: string; clientId: string; refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const url = new URL('/oauth/token', args.issuer).toString()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  })
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
  const refreshToken =
    typeof rawRefresh === 'string' && rawRefresh.length > 0
      ? rawRefresh
      : args.refreshToken
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
