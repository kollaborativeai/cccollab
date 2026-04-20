import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import type { FunctionReference } from 'convex/server'
import { anyApi } from 'convex/server'

import { loadHostedConfig, saveHostedConfig, type HostedConfig } from './config.js'

/** See `hosted/auth.ts` for rationale on runtime-typed action references. */
const SIGNIN_ACTION = (anyApi as { auth: { signIn: unknown } }).auth.signIn as FunctionReference<'action'>

/**
 * Create a `ConvexClient` for the hosted transport, wired with an
 * `AuthTokenFetcher` that refreshes the access token via the Convex
 * Auth `signIn({ refreshToken })` path when Convex signals the token
 * has expired.
 *
 * Critical invariant for token refresh (per Convex Auth docs): the
 * refresh token is SINGLE-USE. After a successful refresh we MUST
 * persist the new refresh token atomically before using it again;
 * reusing an old refresh token invalidates the entire session on the
 * server side. This factory serialises refresh calls through a single
 * pending promise so we never issue two refreshes for the same stored
 * refresh token.
 */
export function createHostedClient(initialConfig: HostedConfig): ConvexClient {
  const client = new ConvexClient(initialConfig.hostedUrl)
  let currentAccessToken = initialConfig.accessToken
  let currentRefreshToken = initialConfig.refreshToken
  let refreshInFlight: Promise<string | null> | null = null

  client.setAuth(async ({ forceRefreshToken }) => {
    if (!forceRefreshToken && currentAccessToken !== '') {
      return currentAccessToken
    }
    if (refreshInFlight !== null) return await refreshInFlight
    refreshInFlight = (async () => {
      try {
        const next = await refreshTokens(initialConfig.hostedUrl, currentRefreshToken)
        if (next === null) {
          // Refresh failed: clear in-memory tokens and surface null so
          // Convex flips to unauthenticated. The caller (hosted
          // transport) should trip its degradation switch on the next
          // operation.
          currentAccessToken = ''
          return null
        }
        currentAccessToken = next.accessToken
        currentRefreshToken = next.refreshToken
        saveHostedConfig({
          ...initialConfig,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
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

async function refreshTokens(hostedUrl: string, refreshToken: string): Promise<RefreshedTokens | null> {
  if (refreshToken === '') return null
  const http = new ConvexHttpClient(hostedUrl)
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

/**
 * Rewrite of `createHostedClient` that sources its initial state from
 * disk via `loadHostedConfig()`. Returns `null` when hosted mode is
 * not configured (no URL, or no tokens). Used by `server.ts` at
 * startup.
 */
export function createHostedClientIfConfigured(): ConvexClient | null {
  const cfg = loadHostedConfig()
  if (cfg === null) return null
  if (cfg.accessToken === '' || cfg.refreshToken === '') return null
  return createHostedClient(cfg)
}
