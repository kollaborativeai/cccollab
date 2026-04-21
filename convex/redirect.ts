/**
 * Allow-list check for Convex Auth's `redirect` callback.
 *
 * Two legitimate destinations:
 *
 * 1. The first-party cccollab local MCP server's loopback listener:
 *    `http://127.0.0.1:<port>/cccollab-oauth-callback`. Exact pathname,
 *    no userinfo, loopback-only. See file history for why `localhost` is
 *    rejected — it can resolve to IPv6 or a user-controlled DNS entry.
 *
 * 2. Same-origin `/authorize?...` on this Convex deployment. Used by the
 *    external-AI OAuth flow (CCC-22): when a user visits `/authorize`
 *    unauthenticated, we bounce them through Convex Auth's Google sign-in
 *    with `redirectTo` set to the original `/authorize` URL so the callback
 *    returns them to the same `/authorize` after the browser cookie is set.
 *    The "same origin" check is against `CONVEX_SITE_URL`, which Convex
 *    injects into every deployment's env at runtime.
 *
 * Any other destination is rejected so an attacker can't coerce the OAuth
 * flow into redirecting to a phishing origin.
 *
 * Kept as a pure function so the Convex callback in `convex/auth.ts` is a
 * one-liner and the policy is testable without going through the OAuth
 * flow.
 */
export const OAUTH_CALLBACK_PATH = '/cccollab-oauth-callback'
export const AUTHORIZE_PATH = '/authorize'

export function isAllowedRedirect(redirectTo: string): boolean {
  let url: URL
  try {
    url = new URL(redirectTo)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false

  // 1. Loopback: first-party MCP server callback.
  if (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.pathname === OAUTH_CALLBACK_PATH &&
    url.search === '' &&
    url.hash === ''
  ) {
    return true
  }

  // 2. Same-origin /authorize on this deployment (external-AI OAuth flow).
  const siteUrl = process.env.CONVEX_SITE_URL
  if (siteUrl) {
    let site: URL
    try {
      site = new URL(siteUrl)
    } catch {
      return false
    }
    if (
      url.protocol === site.protocol &&
      url.hostname === site.hostname &&
      url.port === site.port &&
      url.pathname === AUTHORIZE_PATH &&
      url.hash === ''
    ) {
      // The /authorize URL carries its original query string on the way
      // back; that's the whole point of bouncing through sign-in. Don't
      // filter on `search === ''` here.
      return true
    }
  }

  return false
}
