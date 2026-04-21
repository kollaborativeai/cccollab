// Small crypto helpers used by OAuth and token issuance.
// All functions use the Web Crypto API so they work inside the Convex runtime.

function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  // `btoa` is available in the Convex runtime, Node >= 16, and Edge runtimes.
  const b64 = btoa(s)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(new Uint8Array(digest))
}

export async function verifyPkceS256(args: { verifier: string; challenge: string }): Promise<boolean> {
  const expected = await sha256Base64Url(args.verifier)
  return timingSafeEqual(expected, args.challenge)
}

function timingSafeEqual(a: string, b: string): boolean {
  // Always iterate the longer of the two strings so the comparison takes the
  // same amount of time whether the lengths match or not. Length mismatch is
  // still a "not equal" signal via the initial XOR on lengths.
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    const ac = i < a.length ? a.charCodeAt(i) : 0
    const bc = i < b.length ? b.charCodeAt(i) : 0
    diff |= ac ^ bc
  }
  return diff === 0
}
