import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { anyApi } from 'convex/server'

import { saveLocationAuth } from '../config/save.js'

/** See `remote/auth.ts` for rationale on runtime-typed action references. */
const SIGNIN_ACTION = (anyApi as { auth: { signIn: unknown } }).auth.signIn as FunctionReference<'action'>

export interface RemoteClientInit {
  /** Location name (the key under `locations` in the resolved config).
   *  Used when persisting refreshed tokens via `saveLocationAuth`. */
  locationName: string
  /** Convex deployment URL for this location. */
  url: string
  /** Current access token (JWT). May be empty on first use; callers
   *  that see an empty string should not construct a client. */
  accessToken: string
  /** Current refresh token (single-use per Convex Auth docs). */
  refreshToken: string
  /** Optional extra fields preserved through refresh roundtrips so the
   *  persisted config retains a coherent identity. */
  userEmail?: string
  userId?: string
}

/**
 * Construct a `ConvexClient` for a single remote location, wired with
 * an `AuthTokenFetcher` that refreshes the access token via the Convex
 * Auth `signIn({ refreshToken })` path when the server signals the
 * token has expired.
 *
 * Critical invariant for token refresh (per Convex Auth docs): the
 * refresh token is SINGLE-USE. After a successful refresh we MUST
 * persist the new refresh token atomically before using it again;
 * reusing an old refresh token invalidates the entire session on the
 * server side. This factory serialises refresh calls through a single
 * pending promise so we never issue two refreshes for the same stored
 * refresh token. The persisted update goes through `saveLocationAuth`
 * so the user-level file's other locations and top-level fields are
 * preserved.
 */
export function createRemoteClient(init: RemoteClientInit): ConvexClient {
  const client = new ConvexClient(init.url)
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
        const next = await refreshTokens(init.url, currentRefreshToken)
        if (next === null) {
          // Refresh failed: clear in-memory tokens and surface null so
          // Convex flips to unauthenticated. The caller (remote
          // transport) should trip its degradation switch on the next
          // operation.
          currentAccessToken = ''
          return null
        }
        currentAccessToken = next.accessToken
        currentRefreshToken = next.refreshToken
        saveLocationAuth(init.locationName, {
          url: init.url,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          userEmail: init.userEmail,
          userId: init.userId,
          updatedAt: Date.now(),
        })
        return next.accessToken
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
