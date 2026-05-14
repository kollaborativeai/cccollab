import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { anyApi } from 'convex/server'

import { loadPersistedLocationAuth, withConfigLock } from '../config/save.js'
import {
  CLERK_CONVEX_AUDIENCE,
  ConvexJwtExchangeError,
  exchangeOAuthTokenForConvexJwt,
  refreshAccessToken,
} from './auth-clerk.js'

/** See `remote/auth.ts` for rationale on runtime-typed action references. */
const SIGNIN_ACTION = (anyApi as { auth: { signIn: unknown } }).auth.signIn as FunctionReference<'action'>

export interface RemoteClientInit {
  /** Location name (the key under `locations` in the resolved config).
   *  Used when persisting refreshed tokens via `saveLocationAuth`. */
  locationName: string
  /** Convex deployment URL for this location. */
  url: string
  /** Auth flow discriminator. Defaults to 'convex-google' for back-compat. */
  authType?: 'convex-google' | 'clerk'
  /** Current access token (JWT). May be empty on first use; callers
   *  that see an empty string should not construct a client. */
  accessToken: string
  /** Current refresh token (single-use per Convex Auth docs). */
  refreshToken: string
  /** Clerk only: epoch ms when accessToken expires. Allows the setAuth
   *  callback to short-circuit refresh when the token is still live. */
  accessTokenExpiresAt?: number
  /** Clerk only: pointer to the Clerk OAuth app. Required for refresh. */
  clerkIssuer?: string
  clerkClientId?: string
  /** Optional extra fields preserved through refresh roundtrips so the
   *  persisted config retains a coherent identity. */
  userEmail?: string
  userId?: string
}

// 10-second safety margin: refresh if token expires in <10s, even
// though it's still nominally valid. Cheap insurance against clock
// skew between the Node process and Clerk's issuer.
export const CLERK_FRESHNESS_MARGIN_MS = 10_000

/**
 * Inner layer: provides a fresh OAuth access token, handling Clerk
 * /oauth/token refresh and cross-process persistence. Exported for tests.
 *
 * The returned `getOAuthToken({forceRefresh})` returns the current OAuth
 * access token, refreshing it (and persisting to disk) when needed.
 * Returns null if refresh fails (e.g. refresh token revoked).
 *
 * Behavior contract:
 *  - When the cached token is still fresh (expiresAt > now + margin) AND
 *    `forceRefresh` is false → return cached token immediately.
 *  - When a refresh is in-flight (another concurrent call in the same
 *    process) → await and return the same result.
 *  - Otherwise → enter `withConfigLock`, detect peer-process refresh
 *    (disk token newer AND still-fresh), or call refreshAccessToken,
 *    persist the new tokens, and return the new accessToken.
 *  - On any refresh failure → clear in-memory accessToken, return null.
 */
export function makeOAuthAccessTokenProvider(
  init: Required<Pick<RemoteClientInit, 'locationName' | 'url' | 'clerkIssuer' | 'clerkClientId'>> &
    Pick<RemoteClientInit, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'userEmail' | 'userId'>,
): { getOAuthToken: (args: { forceRefresh: boolean }) => Promise<string | null> } {
  const { clerkIssuer, clerkClientId } = init
  let currentAccessToken = init.accessToken
  let currentRefreshToken = init.refreshToken
  let currentExpiresAt = init.accessTokenExpiresAt ?? 0
  let inFlight: Promise<string | null> | null = null

  async function getOAuthToken({ forceRefresh }: { forceRefresh: boolean }): Promise<string | null> {
    const now = Date.now()
    const stillFresh = currentAccessToken !== '' && currentExpiresAt - now > CLERK_FRESHNESS_MARGIN_MS
    if (!forceRefresh && stillFresh) return currentAccessToken
    if (inFlight !== null) return await inFlight

    inFlight = (async () => {
      try {
        return await withConfigLock(async (persist) => {
          // Peer-process detection: if disk has a newer access token
          // that's still fresh, adopt it instead of issuing a refresh.
          // This avoids burning a refresh token slot when a sibling MCP
          // process just rotated.
          const onDisk = loadPersistedLocationAuth(init.locationName)
          if (
            onDisk &&
            typeof onDisk.accessToken === 'string' &&
            onDisk.accessToken !== '' &&
            typeof onDisk.accessTokenExpiresAt === 'number' &&
            onDisk.accessTokenExpiresAt - Date.now() > CLERK_FRESHNESS_MARGIN_MS &&
            onDisk.accessTokenExpiresAt > currentExpiresAt
          ) {
            currentAccessToken = onDisk.accessToken
            currentExpiresAt = onDisk.accessTokenExpiresAt
            if (typeof onDisk.refreshToken === 'string' && onDisk.refreshToken !== '') {
              currentRefreshToken = onDisk.refreshToken
            }
            return currentAccessToken
          }

          if (currentRefreshToken === '') {
            currentAccessToken = ''
            return null
          }

          try {
            const next = await refreshAccessToken({
              issuer: clerkIssuer,
              clientId: clerkClientId,
              refreshToken: currentRefreshToken,
              resource: CLERK_CONVEX_AUDIENCE,
            })
            currentAccessToken = next.accessToken
            currentRefreshToken = next.refreshToken
            currentExpiresAt = next.accessTokenExpiresAt
            persist(init.locationName, {
              authType: 'clerk',
              url: init.url,
              accessToken: next.accessToken,
              refreshToken: next.refreshToken,
              accessTokenExpiresAt: next.accessTokenExpiresAt,
              userEmail: init.userEmail,
              userId: init.userId,
              updatedAt: Date.now(),
            })
            return next.accessToken
          } catch {
            // Refresh call failed (network, invalid_grant, etc).
            // Clear in-memory access token; surface null so the SDK
            // flips to unauthenticated. The user can re-run
            // `authenticate` to recover.
            currentAccessToken = ''
            return null
          }
        })
      } finally {
        inFlight = null
      }
    })()
    return await inFlight
  }

  return { getOAuthToken }
}

/**
 * Build the setAuth callback for a Clerk-backed remote location.
 *
 * Exported for testing: tests can call the returned function directly
 * without threading through the ConvexClient SDK internals.
 *
 * The returned function has the same signature as what `client.setAuth`
 * expects: `({ forceRefreshToken }: { forceRefreshToken: boolean }) =>
 * Promise<string | null>`.
 *
 * Two-layer architecture:
 *  1. Inner layer (makeOAuthAccessTokenProvider): handles OAuth token
 *     refresh + cross-process persistence (existing B7 behavior).
 *  2. Outer layer (this function): exchanges the OAuth token for a
 *     Convex-audience JWT via KAI's /cccollab/exchangeToken endpoint.
 *     Convex JWTs (~60s lifetime) are cached in memory only — never
 *     persisted, re-exchange is cheap.
 *
 * INVALID_OAUTH_TOKEN from KAI triggers a forced OAuth refresh and a
 * single retry; other exchange errors flip Convex to unauthenticated
 * via null return.
 *
 * The outer `inFlight` is separate from the inner provider's `inFlight`
 * — they serialize different operations.
 */
export function makeClerkAuthFetcher(
  init: Required<Pick<RemoteClientInit, 'locationName' | 'url' | 'clerkIssuer' | 'clerkClientId'>> &
    Pick<RemoteClientInit, 'accessToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'userEmail' | 'userId'>,
  // Optional fetch injection for tests of the exchange path
  fetchImpl?: typeof fetch,
): (args: { forceRefreshToken: boolean }) => Promise<string | null> {
  const { getOAuthToken } = makeOAuthAccessTokenProvider(init)
  let currentConvexJwt = ''
  let currentConvexJwtExpiresAt = 0
  let inFlight: Promise<string | null> | null = null

  return async function clerkAuthFetcher({ forceRefreshToken }): Promise<string | null> {
    const now = Date.now()
    const stillFresh = currentConvexJwt !== '' && currentConvexJwtExpiresAt - now > CLERK_FRESHNESS_MARGIN_MS
    if (!forceRefreshToken && stillFresh) return currentConvexJwt
    if (inFlight !== null) return await inFlight

    inFlight = (async () => {
      try {
        // Phase 1: get a fresh OAuth access token (let inner layer decide freshness)
        let oauthToken = await getOAuthToken({ forceRefresh: false })
        if (oauthToken === null) {
          currentConvexJwt = ''
          return null
        }

        // Phase 2: exchange for Convex JWT
        try {
          const result = await exchangeOAuthTokenForConvexJwt({ kaiUrl: init.url, oauthToken }, fetchImpl)
          currentConvexJwt = result.jwt
          currentConvexJwtExpiresAt = result.expiresAt
          return result.jwt
        } catch (err) {
          if (err instanceof ConvexJwtExchangeError && err.code === 'INVALID_OAUTH_TOKEN') {
            // OAuth token rejected by KAI/Clerk — force-refresh and retry once.
            oauthToken = await getOAuthToken({ forceRefresh: true })
            if (oauthToken === null) {
              currentConvexJwt = ''
              return null
            }
            const retried = await exchangeOAuthTokenForConvexJwt({ kaiUrl: init.url, oauthToken }, fetchImpl)
            currentConvexJwt = retried.jwt
            currentConvexJwtExpiresAt = retried.expiresAt
            return retried.jwt
          }
          // Other exchange errors (MISSING_SESSION, SESSION_NOT_FOUND,
          // TEMPLATE_NOT_FOUND, EXCHANGE_FAILED, network failures) — return
          // null so Convex flips to unauthenticated.
          currentConvexJwt = ''
          return null
        }
      } finally {
        inFlight = null
      }
    })()
    return await inFlight
  }
}

/**
 * Construct a `ConvexClient` for a single remote location, wired with
 * an `AuthTokenFetcher` that refreshes the access token via the Convex
 * Auth `signIn({ refreshToken })` path when the server signals the
 * token has expired.
 *
 * Critical invariant for token refresh (per Convex Auth docs): the
 * refresh token is SINGLE-USE. Reusing an old refresh token invalidates
 * the entire session on the server side. We defend against losing
 * tokens at two layers:
 *
 *  1. In-process: an `refreshInFlight` promise serialises refresh
 *     attempts so two concurrent token-expiry events in the same
 *     process don't issue two refresh calls.
 *
 *  2. Cross-process: the read+refresh+write happens inside
 *     `withConfigLock`. Before issuing a refresh call we re-read the
 *     persisted refresh token from disk; if a peer process has
 *     refreshed since this process's last read, we adopt their tokens
 *     instead of issuing a stale-token refresh that Convex would
 *     reject. Without this, two MCP processes that loaded the same
 *     refresh token at startup would race their first refresh, and
 *     the loser would degrade with an UNAUTHENTICATED error.
 */
export function createRemoteClient(init: RemoteClientInit): ConvexClient {
  const client = new ConvexClient(init.url)

  if (init.authType === 'clerk') {
    if (!init.clerkIssuer || !init.clerkClientId) {
      throw new Error(
        `createRemoteClient: authType='clerk' requires clerkIssuer and clerkClientId (location "${init.locationName}")`,
      )
    }
    const fetcher = makeClerkAuthFetcher({
      locationName: init.locationName,
      url: init.url,
      clerkIssuer: init.clerkIssuer,
      clerkClientId: init.clerkClientId,
      accessToken: init.accessToken,
      refreshToken: init.refreshToken,
      accessTokenExpiresAt: init.accessTokenExpiresAt,
      userEmail: init.userEmail,
      userId: init.userId,
    })
    client.setAuth(fetcher)
    return client
  }

  // convex-google branch — unchanged
  let currentAccessToken = init.accessToken
  let currentRefreshToken = init.refreshToken
  let refreshInFlight: Promise<string | null> | null = null

  client.setAuth(async ({ forceRefreshToken }) => {
    if (!forceRefreshToken && currentAccessToken !== '') {
      return currentAccessToken
    }
    if (refreshInFlight !== null) return await refreshInFlight
    refreshInFlight = (async () => {
      try {
        return await withConfigLock(async (persist) => {
          // Re-read the persisted state inside the lock. If a peer
          // process refreshed since we last loaded, adopt their
          // tokens — they're the live ones; ours are now invalidated
          // server-side because Convex Auth refresh tokens are
          // single-use.
          const onDisk = loadPersistedLocationAuth(init.locationName)
          if (
            onDisk &&
            typeof onDisk.refreshToken === 'string' &&
            onDisk.refreshToken !== '' &&
            onDisk.refreshToken !== currentRefreshToken &&
            typeof onDisk.accessToken === 'string' &&
            onDisk.accessToken !== ''
          ) {
            currentAccessToken = onDisk.accessToken
            currentRefreshToken = onDisk.refreshToken
            return currentAccessToken
          }

          const next = await refreshTokens(init.url, currentRefreshToken)
          if (next === null) {
            // Refresh failed: clear in-memory tokens and surface null
            // so Convex flips to unauthenticated. The caller (remote
            // transport) should trip its degradation switch on the
            // next operation.
            currentAccessToken = ''
            return null
          }
          currentAccessToken = next.accessToken
          currentRefreshToken = next.refreshToken
          persist(init.locationName, {
            url: init.url,
            accessToken: next.accessToken,
            refreshToken: next.refreshToken,
            userEmail: init.userEmail,
            userId: init.userId,
            updatedAt: Date.now(),
          })
          return next.accessToken
        })
      } finally {
        refreshInFlight = null
      }
    })()
    return await refreshInFlight
  })

  return client
}

interface RefreshedTokens {
  accessToken: string
  refreshToken: string
}

async function refreshTokens(remoteUrl: string, refreshToken: string): Promise<RefreshedTokens | null> {
  if (refreshToken === '') return null
  const http = new ConvexHttpClient(remoteUrl)
  try {
    const res = (await http.action(SIGNIN_ACTION, {
      refreshToken,
      calledBy: 'cccollab-mcp-server',
    })) as { tokens?: { token: string; refreshToken: string } | null }
    if (!res.tokens || !res.tokens.token || !res.tokens.refreshToken) {
      return null
    }
    return { accessToken: res.tokens.token, refreshToken: res.tokens.refreshToken }
  } catch {
    return null
  } finally {
    // ConvexHttpClient holds no connection state; nothing to close.
    void http
  }
}
