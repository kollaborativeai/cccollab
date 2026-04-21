import { describe, it, expect } from 'vitest'

import { OAUTH_CALLBACK_PATH, isAllowedRedirect } from './redirect'

describe('isAllowedRedirect', () => {
  it('accepts literal 127.0.0.1 on any port with the cccollab callback path', () => {
    expect(isAllowedRedirect('http://127.0.0.1:49152/cccollab-oauth-callback')).toBe(true)
    expect(isAllowedRedirect('http://127.0.0.1:1/cccollab-oauth-callback')).toBe(true)
  })

  it('rejects `localhost` — it can resolve to ::1 or a user-controlled host, and the MCP server only ever binds 127.0.0.1', () => {
    expect(isAllowedRedirect('http://localhost:51000/cccollab-oauth-callback')).toBe(false)
  })

  it('rejects URLs with a userinfo component (username/password bypasses hostname-only checks)', () => {
    expect(isAllowedRedirect('http://attacker.com@127.0.0.1:1234/cccollab-oauth-callback')).toBe(false)
    expect(isAllowedRedirect('http://user:pass@127.0.0.1:1234/cccollab-oauth-callback')).toBe(false)
  })

  it('rejects non-loopback hosts', () => {
    expect(isAllowedRedirect('http://example.com/cccollab-oauth-callback')).toBe(false)
    expect(isAllowedRedirect('http://evil.flatout.solutions/cccollab-oauth-callback')).toBe(false)
  })

  it('rejects IPv6 loopback', () => {
    expect(isAllowedRedirect('http://[::1]:49152/cccollab-oauth-callback')).toBe(false)
  })

  it('rejects https (loopback is only ever http)', () => {
    expect(isAllowedRedirect('https://127.0.0.1:49152/cccollab-oauth-callback')).toBe(false)
  })

  it('rejects callbacks on a different path', () => {
    expect(isAllowedRedirect('http://127.0.0.1:49152/other')).toBe(false)
    expect(isAllowedRedirect('http://127.0.0.1:49152/')).toBe(false)
    expect(isAllowedRedirect('http://127.0.0.1:49152/cccollab-oauth-callback/sub')).toBe(false)
  })

  it('rejects callbacks with extra query string', () => {
    expect(isAllowedRedirect('http://127.0.0.1:49152/cccollab-oauth-callback?x=1')).toBe(false)
  })

  it('rejects callbacks with a hash', () => {
    expect(isAllowedRedirect('http://127.0.0.1:49152/cccollab-oauth-callback#frag')).toBe(false)
  })

  it('rejects malformed URLs', () => {
    expect(isAllowedRedirect('not a url')).toBe(false)
    expect(isAllowedRedirect('')).toBe(false)
  })

  it('exposes the callback path as a shared constant', () => {
    expect(OAUTH_CALLBACK_PATH).toBe('/cccollab-oauth-callback')
  })
})
