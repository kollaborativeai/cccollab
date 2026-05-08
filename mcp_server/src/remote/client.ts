import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { anyApi } from 'convex/server'

import { loadPersistedLocationAuth, withConfigLock } from '../config/save.js'

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
