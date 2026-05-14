import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  generateCodeVerifier,
  deriveCodeChallenge,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
} from '../../src/remote/auth-clerk.js'

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

describe('buildAuthorizeUrl', () => {
  it('produces a Clerk-compatible OAuth authorize URL', () => {
    const url = buildAuthorizeUrl({
      issuer: 'https://x.clerk.accounts.dev',
      clientId: 'cccollab-cli',
      redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
      codeChallenge: 'abc123',
      state: 'state-xyz',
    })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://x.clerk.accounts.dev/oauth/authorize')
    expect(u.searchParams.get('client_id')).toBe('cccollab-cli')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:12345/cccollab-oauth-callback')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('code_challenge')).toBe('abc123')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('state')).toBe('state-xyz')
    expect(u.searchParams.get('scope')).toBe('openid profile email')
  })
})

describe('exchangeCodeForTokens', () => {
  it('POSTs the right form to /oauth/token and returns parsed tokens', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = []
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: init.body as string,
        headers: init.headers as Record<string, string>,
      })
      return new Response(
        JSON.stringify({
          access_token: 'at_123',
          refresh_token: 'rt_456',
          expires_in: 60,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const result = await exchangeCodeForTokens(
      {
        issuer: 'https://x.clerk.accounts.dev',
        clientId: 'cccollab-cli',
        redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
        code: 'code-abc',
        codeVerifier: 'verifier-xyz',
      },
      fetchMock,
    )

    expect(result.accessToken).toBe('at_123')
    expect(result.refreshToken).toBe('rt_456')
    expect(result.accessTokenExpiresAt).toBeGreaterThan(Date.now())
    expect(calls).toHaveLength(1)
    const [firstCall] = calls
    expect(firstCall).toBeDefined()
    expect(firstCall?.url).toBe('https://x.clerk.accounts.dev/oauth/token')
    const body = new URLSearchParams(firstCall?.body ?? '')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code-abc')
    expect(body.get('code_verifier')).toBe('verifier-xyz')
    expect(body.get('client_id')).toBe('cccollab-cli')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:12345/cccollab-oauth-callback')
  })

  it('throws on non-200 token response', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    await expect(
      exchangeCodeForTokens(
        {
          issuer: 'https://x.clerk.accounts.dev',
          clientId: 'cccollab-cli',
          redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
          code: 'bad',
          codeVerifier: 'v',
        },
        fetchMock,
      ),
    ).rejects.toThrow(/invalid_grant/)
  })
})

describe('refreshAccessToken', () => {
  it('exchanges refresh token for new tokens', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'new_at',
          refresh_token: 'new_rt',
          expires_in: 60,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    const result = await refreshAccessToken(
      { issuer: 'https://x.clerk.accounts.dev', clientId: 'cccollab-cli', refreshToken: 'old_rt' },
      fetchMock,
    )
    expect(result.accessToken).toBe('new_at')
    expect(result.refreshToken).toBe('new_rt')
  })

  it('preserves prior refresh token if server omits one', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const result = await refreshAccessToken(
      { issuer: 'https://x.clerk.accounts.dev', clientId: 'cccollab-cli', refreshToken: 'old_rt' },
      fetchMock,
    )
    expect(result.refreshToken).toBe('old_rt')
  })

  it('preserves prior refresh token if server returns empty string', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'new_at', refresh_token: '', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const result = await refreshAccessToken(
      { issuer: 'https://x.clerk.accounts.dev', clientId: 'cccollab-cli', refreshToken: 'old_rt' },
      fetchMock,
    )
    expect(result.refreshToken).toBe('old_rt')
  })
})
