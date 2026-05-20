import { ConvexClient } from 'convex/browser'

import { loadPersistedLocationAuth, withConfigLock } from '../config/save.js'
import {
  CLERK_CONVEX_AUDIENCE,
  ConvexJwtExchangeError,
  exchangeOAuthTokenForConvexJwt,
  refreshAccessToken,
} from './auth-clerk.js'

export interface RemoteClientInit {
  /** Location name (the key under `locations` in the resolved config).
   *  Used when persisting refreshed tokens via `saveLocationAuth`. */
  locationName: string
  /** Convex deployment URL for this location. */
  url: string
  /** Current access token (Clerk OAuth). May be empty on first use; callers
   *  that see an empty string should not construct a client. */
  accessToken: string
  /** Current refresh token. */
  refreshToken: string
  /** Epoch ms when accessToken expires. Allows the setAuth callback to
   *  short-circuit refresh when the token is still live. */
  accessTokenExpiresAt?: number
  /** Pointer to the Clerk OAuth app. Required for refresh. */
  clerkIssuer: string
  clerkClientId: string
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
            // If the retry also throws (e.g. durable misconfig like a Clerk-
            // instance mismatch where the kid never resolves), swallow it and
            // surface null so Convex flips to unauthenticated rather than
            // letting the rejection escape as an unhandled promise rejection.
            try {
              oauthToken = await getOAuthToken({ forceRefresh: true })
              if (oauthToken === null) {
                currentConvexJwt = ''
                return null
              }
              const retried = await exchangeOAuthTokenForConvexJwt({ kaiUrl: init.url, oauthToken }, fetchImpl)
              currentConvexJwt = retried.jwt
              currentConvexJwtExpiresAt = retried.expiresAt
              return retried.jwt
            } catch {
              currentConvexJwt = ''
              return null
            }
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
 * the Clerk auth fetcher built by `makeClerkAuthFetcher`. The fetcher
 * handles OAuth-token refresh, cross-process persistence, and the
 * OAuth-token-to-Convex-JWT exchange transparently.
 */
export function createRemoteClient(init: RemoteClientInit): ConvexClient {
  const client = new ConvexClient(init.url)
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
