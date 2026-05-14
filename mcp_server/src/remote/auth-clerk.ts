import { createHash, randomBytes } from 'node:crypto'

/**
 * Generate a cryptographically-random PKCE code verifier per RFC 7636 §4.1.
 * 64 bytes of randomness → 86-char base64url string (well within the 43-128
 * char limit).
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(64))
}

/**
 * Derive the S256 code challenge for a given verifier (RFC 7636 §4.2).
 */
export function deriveCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest())
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
