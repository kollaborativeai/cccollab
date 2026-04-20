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
 * - hostname MUST be `127.0.0.1` or `localhost`
 * - pathname MUST be exactly `/cccollab-oauth-callback`
 * - no query / hash component is permitted
 * - any port number on the loopback interface is allowed
 *
 * IPv6 loopback (`::1`) is intentionally rejected - Node's `http.listen`
 * on `127.0.0.1` already binds IPv4, and allowing `[::1]` would expand
 * the attack surface without any developer benefit.
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
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false
  if (url.pathname !== OAUTH_CALLBACK_PATH) return false
  if (url.search !== '' || url.hash !== '') return false
  return true
}
