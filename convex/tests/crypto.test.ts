import { describe, it, expect } from 'vitest'
import { randomToken, sha256Base64Url, verifyPkceS256 } from '../lib/crypto.js'

describe('crypto helpers', () => {
  it('randomToken returns url-safe string of expected length', () => {
    const token = randomToken(32)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 bytes -> at least 43 base64url chars (no padding)
    expect(token.length).toBeGreaterThanOrEqual(43)
  })

  it('randomToken returns unique tokens on repeated calls', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(randomToken(16))
    expect(seen.size).toBe(100)
  })

  it('sha256Base64Url returns url-safe base64 of sha256', async () => {
    const h = await sha256Base64Url('hello')
    expect(h).toBe('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')
  })

  it('verifyPkceS256 validates a known verifier/challenge pair', async () => {
    const verifier = 'abc123'
    const challenge = await sha256Base64Url(verifier)
    expect(await verifyPkceS256({ verifier, challenge })).toBe(true)
    expect(await verifyPkceS256({ verifier, challenge: 'wrong' })).toBe(false)
  })
})
