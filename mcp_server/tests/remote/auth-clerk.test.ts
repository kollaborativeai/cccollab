import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { generateCodeVerifier, deriveCodeChallenge } from '../../src/remote/auth-clerk.js'

describe('PKCE primitives', () => {
  it('generateCodeVerifier produces an 86-char base64url string', () => {
    const v = generateCodeVerifier()
    expect(v).toHaveLength(86)
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('generateCodeVerifier produces unique values', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()))
    expect(set.size).toBe(50)
  })

  it('deriveCodeChallenge is base64url(SHA256(verifier))', () => {
    const verifier = 'test_verifier_abcdef0123456789-_~ABCDEFGHIJK'
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(deriveCodeChallenge(verifier)).toBe(expected)
  })
})
