import { describe, it, expect } from 'vitest'

import { ALLOWED_EMAIL_DOMAINS, emailDomain, isAllowedEmail } from './allowlist'

describe('emailDomain', () => {
  it('returns the lowercase domain portion', () => {
    expect(emailDomain('stefan@flatout.solutions')).toBe('flatout.solutions')
  })

  it('lowercases mixed-case domains', () => {
    expect(emailDomain('Stefan@FlatOut.Solutions')).toBe('flatout.solutions')
  })

  it('returns an empty string when no @ is present', () => {
    expect(emailDomain('not-an-email')).toBe('')
  })

  it('uses the last @ for gnarly addresses', () => {
    expect(emailDomain('foo"@"bar@flatout.solutions')).toBe('flatout.solutions')
  })
})

describe('isAllowedEmail', () => {
  it('accepts emails on the allow-list', () => {
    expect(isAllowedEmail('stefan@flatout.solutions')).toBe(true)
  })

  it('accepts case-variant emails on the allow-list', () => {
    expect(isAllowedEmail('Stefan@FlatOut.Solutions')).toBe(true)
  })

  it('rejects public-domain emails', () => {
    expect(isAllowedEmail('bob@gmail.com')).toBe(false)
  })

  it('rejects emails from other FlatOut domains until they are added', () => {
    // flatout.ventures is a sibling brand; until it is explicitly added the
    // allow-list rejects it so we fail closed rather than fail open.
    expect(isAllowedEmail('stefan@flatout.ventures')).toBe(false)
  })

  it('rejects empty/undefined/null/non-string inputs', () => {
    expect(isAllowedEmail('')).toBe(false)
    expect(isAllowedEmail(undefined)).toBe(false)
    expect(isAllowedEmail(null)).toBe(false)
  })

  it('rejects malformed addresses with no @', () => {
    expect(isAllowedEmail('not-an-email')).toBe(false)
  })
})

describe('ALLOWED_EMAIL_DOMAINS', () => {
  it('is frozen at module scope', () => {
    // TypeScript's `readonly` is erased at runtime; guard against
    // accidental mutation by asserting the export shape. If the list
    // changes legitimately the assertion fails loudly.
    expect(ALLOWED_EMAIL_DOMAINS).toEqual(['flatout.solutions'])
  })
})
