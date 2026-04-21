/**
 * Small crypto helpers used by the OAuth 2.1 authorization server and
 * MCP bearer-token validation.
 *
 * Runtime note: `crypto.getRandomValues` is available in both Convex
 * mutations and actions. `crypto.subtle.digest` is ONLY available in
 * actions, NOT mutations — the mutation isolate doesn't expose the
 * SubtleCrypto API. So `sha256Base64Url` callers must run in an action
 * context, and mutations that need to verify PKCE receive the
 * pre-computed hash as a string (see `exchangeCodeForTokens`).
 *
 * `timingSafeEqual` is used by both mutations and actions and operates on
 * ASCII-only strings in practice (base64url-encoded hashes + challenges).
 */

function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  const b64 = btoa(s)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Random token of `byteLength` random bytes, encoded as url-safe base64.
 *  Default 32 bytes = 256 bits of entropy = 43 base64url chars.
 *  Callable from both actions and mutations. */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

/** SHA-256 of `input` (UTF-8), encoded as url-safe base64.
 *  **Must be called from an action context** — `crypto.subtle` is not
 *  available in the Convex mutation isolate. */
export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(new Uint8Array(digest))
}

/** Constant-time string equality over ASCII strings. Iterates `max(|a|,|b|)`
 *  and XORs lengths in so both the length-equal and length-unequal paths
 *  take the same time. Used for PKCE challenge and client-secret hash
 *  comparisons — both are base64url-encoded so ASCII-only by construction. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    const ac = i < a.length ? a.charCodeAt(i) : 0
    const bc = i < b.length ? b.charCodeAt(i) : 0
    diff |= ac ^ bc
  }
  return diff === 0
}
