/**
 * Small crypto helpers used by the OAuth 2.1 authorization server and
 * MCP bearer-token validation. Everything here uses the Web Crypto API
 * (`crypto.getRandomValues`, `crypto.subtle.digest`) which is available
 * in the Convex runtime, Node >= 16, and Edge runtimes — the same three
 * surfaces our convex-test + production deploy + CI have to run on.
 */

function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  const b64 = btoa(s)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 256-bit random token, encoded as url-safe base64 (43 chars for 32 bytes). */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

/** SHA-256 of `input` (UTF-8), encoded as url-safe base64. */
export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(new Uint8Array(digest))
}

/**
 * PKCE S256 verifier check. Returns true iff
 * `base64url(sha256(verifier)) === challenge`. Comparison is constant-time
 * across both equal and unequal lengths to avoid leaking the stored
 * challenge's length via timing.
 */
export async function verifyPkceS256(args: { verifier: string; challenge: string }): Promise<boolean> {
  const expected = await sha256Base64Url(args.verifier)
  return timingSafeEqual(expected, args.challenge)
}

/** Constant-time string equality; iterates max length, XORs lengths. */
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
