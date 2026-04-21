/**
 * Allow-list check for Convex Auth's `redirect` callback.
 *
 * The cccollab local MCP server is the only first-party client at the
 * moment. Its OAuth flow opens a loopback HTTP listener on an ephemeral
 * port and then tells Convex "when the Google exchange is done, redirect
 * the user back to http://127.0.0.1:<port>/cccollab-oauth-callback".
 *
 * Convex Auth requires us to whitelist those URLs here so an attacker
 * can't coerce the OAuth flow into redirecting to a phishing origin.
 *
 * The allow rule is intentionally narrow:
 * - scheme MUST be `http:` (loopback only)
 * - hostname MUST be exactly `127.0.0.1`
 * - NO userinfo component (`user:pass@host` bypasses hostname-only checks)
 * - pathname MUST be exactly `/cccollab-oauth-callback`
 * - no query / hash component is permitted
 * - any port number on the loopback interface is allowed
 *
 * `localhost` is intentionally rejected. The MCP server only ever binds
 * to `127.0.0.1`, and `localhost` can resolve to IPv6 (`::1`) or a
 * user-controlled DNS entry — accepting it would let a local process
 * that can bind the right port race the MCP server's ephemeral listener
 * and intercept the OAuth code.
 *
 * IPv6 loopback (`::1`) is rejected for the same binding reason.
 *
 * Kept as a pure function so the Convex callback in `convex/auth.ts` is
 * a one-liner and the policy is testable without going through the
 * OAuth flow.
 */
export const OAUTH_CALLBACK_PATH = '/cccollab-oauth-callback'

export function isAllowedRedirect(redirectTo: string): boolean {
  let url: URL
  try {
    url = new URL(redirectTo)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.hostname !== '127.0.0.1') return false
  if (url.pathname !== OAUTH_CALLBACK_PATH) return false
  if (url.search !== '' || url.hash !== '') return false
  return true
}
