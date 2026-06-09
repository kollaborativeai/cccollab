import { ConvexClient } from 'convex/browser'

import { loadPersistedLocationAuth, withConfigLock } from '../config/save.js'
import { refreshAccessToken } from './auth-clerk.js'

export interface RemoteClientInit {
  /** Location name (the key under `locations` in the resolved config).
   *  Used when persisting refreshed tokens via `saveLocationAuth`. */
  locationName: string
  /** Convex deployment URL for this location. */
  url: string
  /** Current OAuth access token (Clerk). Not sent to Convex — it carries no
   *  usable `aud` — but rotated on refresh and persisted alongside the rest. */
  accessToken: string
  /** Current OIDC ID token (JWT). This is the token handed to Convex via
   *  `setAuth`: its `aud` is the OAuth Client ID, matching the deployment's
   *  auth.config.ts provider. May be empty on first use. */
  idToken: string
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
 * Build the `setAuth` callback for a Clerk-backed remote location.
 *
 * Exported for testing: tests can call the returned function directly
 * without threading through the ConvexClient SDK internals.
 *
 * The returned function matches what `client.setAuth` expects:
 * `({ forceRefreshToken }: { forceRefreshToken: boolean }) =>
 * Promise<string | null>`. It returns the **OIDC ID token** — the token
 * Convex verifies (its `aud` is the OAuth Client ID, matching the
 * deployment's auth.config.ts provider). The OAuth access token is never
 * sent to Convex; it carries no usable `aud`.
 *
 * Behavior contract:
 *  - When the ID token is still fresh (expiresAt > now + margin) AND
 *    `forceRefreshToken` is false → return the cached ID token immediately.
 *  - When a refresh is in-flight (another concurrent call in the same
 *    process) → await and return the same result.
 *  - Otherwise → enter `withConfigLock`, adopt a peer process's freshly
 *    refreshed tokens from disk if present, else call `refreshAccessToken`,
 *    persist the new tokens, and return the new ID token.
 *  - On any refresh failure → clear the in-memory ID token, return null so
 *    the SDK flips to unauthenticated. The user re-runs `authenticate`.
 *
 * Freshness keys on the access-token expiry as a proxy: Clerk issues the ID
 * and access tokens from the same grant with the same lifetime, and the SDK
 * re-invokes this with `forceRefreshToken: true` after any 401, which covers
 * the rare case where the ID token outlives or predeceases that estimate.
 */
export function makeClerkAuthFetcher(
  init: Required<Pick<RemoteClientInit, 'locationName' | 'url' | 'clerkIssuer' | 'clerkClientId'>> &
    Pick<
      RemoteClientInit,
      'accessToken' | 'idToken' | 'refreshToken' | 'accessTokenExpiresAt' | 'userEmail' | 'userId'
    >,
): (args: { forceRefreshToken: boolean }) => Promise<string | null> {
  const { clerkIssuer, clerkClientId } = init
  let currentIdToken = init.idToken
  let currentRefreshToken = init.refreshToken
  let currentExpiresAt = init.accessTokenExpiresAt ?? 0
  let inFlight: Promise<string | null> | null = null

  return async function clerkAuthFetcher({ forceRefreshToken }): Promise<string | null> {
    const now = Date.now()
    const stillFresh = currentIdToken !== '' && currentExpiresAt - now > CLERK_FRESHNESS_MARGIN_MS
    if (!forceRefreshToken && stillFresh) return currentIdToken
    if (inFlight !== null) return await inFlight

    inFlight = (async () => {
      try {
        return await withConfigLock(async (persist) => {
          // Peer-process detection: if disk has a newer ID token that's
          // still fresh, adopt it instead of issuing a refresh. This avoids
          // burning a single-use refresh token when a sibling MCP process
          // just rotated.
          const onDisk = loadPersistedLocationAuth(init.locationName)
          if (
            onDisk &&
            typeof onDisk.idToken === 'string' &&
            onDisk.idToken !== '' &&
            typeof onDisk.accessTokenExpiresAt === 'number' &&
            onDisk.accessTokenExpiresAt - Date.now() > CLERK_FRESHNESS_MARGIN_MS &&
            onDisk.accessTokenExpiresAt > currentExpiresAt
          ) {
            currentIdToken = onDisk.idToken
            currentExpiresAt = onDisk.accessTokenExpiresAt
            if (typeof onDisk.refreshToken === 'string' && onDisk.refreshToken !== '') {
              currentRefreshToken = onDisk.refreshToken
            }
            return currentIdToken
          }

          if (currentRefreshToken === '') {
            currentIdToken = ''
            return null
          }

          try {
            const next = await refreshAccessToken({
              issuer: clerkIssuer,
              clientId: clerkClientId,
              refreshToken: currentRefreshToken,
              fallbackIdToken: currentIdToken,
            })
            currentIdToken = next.idToken
            currentRefreshToken = next.refreshToken
            currentExpiresAt = next.accessTokenExpiresAt
            persist(init.locationName, {
              authType: 'clerk',
              url: init.url,
              accessToken: next.accessToken,
              refreshToken: next.refreshToken,
              idToken: next.idToken,
              accessTokenExpiresAt: next.accessTokenExpiresAt,
              userEmail: init.userEmail,
              userId: init.userId,
              updatedAt: Date.now(),
            })
            return next.idToken
          } catch {
            // Refresh call failed (network, invalid_grant, etc).
            // Clear the in-memory ID token; surface null so the SDK flips
            // to unauthenticated. The user can re-run `authenticate`.
            currentIdToken = ''
            return null
          }
        })
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
 * handles OAuth-token refresh and cross-process persistence, and returns
 * the OIDC ID token that authenticates Convex.
 */
export function createRemoteClient(init: RemoteClientInit): ConvexClient {
  const client = new ConvexClient(init.url)
  const fetcher = makeClerkAuthFetcher({
    locationName: init.locationName,
    url: init.url,
    clerkIssuer: init.clerkIssuer,
    clerkClientId: init.clerkClientId,
    accessToken: init.accessToken,
    idToken: init.idToken,
    refreshToken: init.refreshToken,
    accessTokenExpiresAt: init.accessTokenExpiresAt,
    userEmail: init.userEmail,
    userId: init.userId,
  })
  client.setAuth(fetcher)
  return client
}
