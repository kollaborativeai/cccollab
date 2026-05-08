import { describe, it, expect, beforeEach, afterEach } from 'vitest'

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

describe('isAllowedRedirect — same-origin /authorize (CCC-22 external-AI flow)', () => {
  let savedSiteUrl: string | undefined
  beforeEach(() => {
    savedSiteUrl = process.env.CONVEX_SITE_URL
    process.env.CONVEX_SITE_URL = 'https://example.convex.site'
  })
  afterEach(() => {
    if (savedSiteUrl === undefined) delete process.env.CONVEX_SITE_URL
    else process.env.CONVEX_SITE_URL = savedSiteUrl
  })

  it('accepts /authorize on the deployment origin (with query string, as expected)', () => {
    expect(
      isAllowedRedirect(
        'https://example.convex.site/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcb&code_challenge=x&code_challenge_method=S256',
      ),
    ).toBe(true)
  })

  it('rejects /authorize on a DIFFERENT origin', () => {
    expect(isAllowedRedirect('https://attacker.convex.site/authorize?foo=bar')).toBe(false)
  })

  it('rejects non-/authorize path on the deployment origin', () => {
    expect(isAllowedRedirect('https://example.convex.site/other')).toBe(false)
    expect(isAllowedRedirect('https://example.convex.site/')).toBe(false)
  })

  it('rejects http:// on the deployment origin (must be https)', () => {
    expect(isAllowedRedirect('http://example.convex.site/authorize')).toBe(false)
  })

  it('rejects a hash component on a same-origin /authorize', () => {
    expect(isAllowedRedirect('https://example.convex.site/authorize?x=1#frag')).toBe(false)
  })

  it('rejects userinfo on same-origin /authorize', () => {
    expect(isAllowedRedirect('https://user:pass@example.convex.site/authorize')).toBe(false)
  })
})
