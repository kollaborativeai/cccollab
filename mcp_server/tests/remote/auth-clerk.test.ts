import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  generateCodeVerifier,
  deriveCodeChallenge,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  runClerkPkce,
  decodeJwtExp,
  DEFAULT_CLERK_REDIRECT_PORT,
} from '../../src/remote/auth-clerk.js'
import type { startLoopbackListener } from '../../src/remote/loopback.js'

/** Build a syntactically-valid JWT carrying only an `exp` claim (no real
 *  signature) for exercising the local freshness checks. */
function jwtWithExp(expSecondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString(
    'base64url',
  )
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`
}

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
  it('produces a Clerk-compatible OAuth authorize URL with openid scope', () => {
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
    // `openid` is required: it makes Clerk issue the ID token that
    // authenticates Convex.
    expect(u.searchParams.get('scope')).toBe('openid profile email')
  })
})

describe('exchangeCodeForTokens', () => {
  it('POSTs the right form to /oauth/token and returns parsed tokens including the ID token', async () => {
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
          id_token: 'id_789',
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
    expect(result.idToken).toBe('id_789')
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

  it('throws when the response omits id_token (openid scope contract violated)', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    await expect(
      exchangeCodeForTokens(
        {
          issuer: 'https://x.clerk.accounts.dev',
          clientId: 'cccollab-cli',
          redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
          code: 'c',
          codeVerifier: 'v',
        },
        fetchMock,
      ),
    ).rejects.toThrow(/Unexpected token response shape/)
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
  it('exchanges refresh token for new tokens including a fresh ID token', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'new_at',
          refresh_token: 'new_rt',
          id_token: 'new_id',
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
    expect(result.idToken).toBe('new_id')
  })

  it('re-sends the openid scope on refresh so Clerk re-issues the id_token (RFC 6749 §6)', async () => {
    const captured: { body: string } = { body: '' }
    const fetchMock = (async (_url: string, init: RequestInit) => {
      captured.body = init.body as string
      return new Response(JSON.stringify({ access_token: 'new_at', id_token: 'new_id', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await refreshAccessToken(
      { issuer: 'https://x.clerk.accounts.dev', clientId: 'cccollab-cli', refreshToken: 'old_rt' },
      fetchMock,
    )
    expect(new URLSearchParams(captured.body).get('scope')).toBe('openid profile email')
  })

  it('falls back to a non-expired prior ID token when the refresh response omits one', async () => {
    const validFallback = jwtWithExp(3600)
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const result = await refreshAccessToken(
      {
        issuer: 'https://x.clerk.accounts.dev',
        clientId: 'cccollab-cli',
        refreshToken: 'old_rt',
        fallbackIdToken: validFallback,
      },
      fetchMock,
    )
    expect(result.idToken).toBe(validFallback)
  })

  it('throws (does not cache) when id_token is omitted and the fallback is an empty string', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await expect(
      refreshAccessToken(
        {
          issuer: 'https://x.clerk.accounts.dev',
          clientId: 'cccollab-cli',
          refreshToken: 'old_rt',
          fallbackIdToken: '',
        },
        fetchMock,
      ),
    ).rejects.toThrow(/Unexpected refresh response shape/)
  })

  it('throws when id_token is omitted and the fallback is already expired', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await expect(
      refreshAccessToken(
        {
          issuer: 'https://x.clerk.accounts.dev',
          clientId: 'cccollab-cli',
          refreshToken: 'old_rt',
          fallbackIdToken: jwtWithExp(-3600),
        },
        fetchMock,
      ),
    ).rejects.toThrow(/Unexpected refresh response shape/)
  })

  it('preserves prior refresh token if server omits one', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'new_at', id_token: 'new_id', expires_in: 60 }), {
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
      new Response(JSON.stringify({ access_token: 'new_at', refresh_token: '', id_token: 'new_id', expires_in: 60 }), {
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

describe('decodeJwtExp', () => {
  it('returns the numeric exp claim from a JWT payload', () => {
    const exp = Math.floor(Date.now() / 1000) + 1234
    const payload = Buffer.from(JSON.stringify({ exp, sub: 'u' })).toString('base64url')
    expect(decodeJwtExp(`h.${payload}.s`)).toBe(exp)
  })

  it('returns null for a malformed token or a payload without exp', () => {
    expect(decodeJwtExp('not-a-jwt')).toBeNull()
    const noExp = Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url')
    expect(decodeJwtExp(`h.${noExp}.s`)).toBeNull()
  })
})

describe('runClerkPkce', () => {
  it('completes the full PKCE flow and returns a TokenSet', async () => {
    let capturedAuthorizeUrl: string | undefined
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'flow_at',
          refresh_token: 'flow_rt',
          id_token: 'flow_id',
          expires_in: 60,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    // Mock listener that resolves immediately with a callback whose state
    // matches whatever runClerkPkce generates — we intercept via onAuthorizeUrl
    // to read the state out of the authorize URL.
    let resolveCallback: (cb: { code: string; state: string | null }) => void = () => {}
    const callbackPromise = new Promise<{ code: string; state: string | null }>((resolve) => {
      resolveCallback = resolve
    })
    const mockListener = {
      port: 54321,
      waitForCallback: () => callbackPromise,
      shutdown: () => {},
    }
    const startListenerImpl = (async () => mockListener) as typeof startLoopbackListener

    const promise = runClerkPkce({
      issuer: 'https://x.clerk.accounts.dev',
      clientId: 'cccollab-cli',
      onAuthorizeUrl: (url) => {
        capturedAuthorizeUrl = url
        const state = new URL(url).searchParams.get('state')
        // Resolve callback with the matching state
        resolveCallback({ code: 'flow-code', state })
      },
      fetchImpl: fetchMock,
      startListenerImpl,
    })

    const result = await promise
    expect(result.accessToken).toBe('flow_at')
    expect(result.refreshToken).toBe('flow_rt')
    expect(result.idToken).toBe('flow_id')
    expect(capturedAuthorizeUrl).toBeDefined()
    expect(capturedAuthorizeUrl).toContain('/oauth/authorize')
    expect(capturedAuthorizeUrl).toContain('code_challenge=')
    expect(capturedAuthorizeUrl).toContain('code_challenge_method=S256')
  })

  it('rejects when the callback state does not match', async () => {
    const fetchMock = (async () => new Response('{}', { status: 200 })) as typeof fetch

    const mockListener = {
      port: 54321,
      waitForCallback: async () => ({ code: 'c', state: 'WRONG_STATE' }),
      shutdown: () => {},
    }
    const startListenerImpl = (async () => mockListener) as typeof startLoopbackListener

    await expect(
      runClerkPkce({
        issuer: 'https://x.clerk.accounts.dev',
        clientId: 'cccollab-cli',
        onAuthorizeUrl: () => {},
        fetchImpl: fetchMock,
        startListenerImpl,
      }),
    ).rejects.toThrow(/state mismatch/)
  })

  it('shuts down the listener even if token exchange fails', async () => {
    let shutdownCalled = false
    const fetchMock = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch

    const mockListener = {
      port: 54321,
      waitForCallback: async () => ({ code: 'c', state: 'matching' }),
      shutdown: () => {
        shutdownCalled = true
      },
    }

    // We need state to match — capture it from authorizeUrl
    let capturedState = ''
    await expect(
      runClerkPkce({
        issuer: 'https://x.clerk.accounts.dev',
        clientId: 'cccollab-cli',
        onAuthorizeUrl: (url) => {
          capturedState = new URL(url).searchParams.get('state') ?? ''
        },
        fetchImpl: fetchMock,
        startListenerImpl: (async () => ({
          ...mockListener,
          waitForCallback: async () => ({ code: 'c', state: capturedState }),
        })) as typeof startLoopbackListener,
      }),
    ).rejects.toThrow(/invalid_grant/)

    expect(shutdownCalled).toBe(true)
  })

  it('uses DEFAULT_CLERK_REDIRECT_PORT when redirectPort is absent', async () => {
    let receivedPort: number | undefined
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', id_token: 'id', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    let capturedState = ''
    await runClerkPkce({
      issuer: 'https://x.clerk.accounts.dev',
      clientId: 'cccollab-cli',
      onAuthorizeUrl: (url) => {
        capturedState = new URL(url).searchParams.get('state') ?? ''
      },
      fetchImpl: fetchMock,
      startListenerImpl: (async (timeoutMs: number, port?: number) => {
        receivedPort = port
        return {
          port: DEFAULT_CLERK_REDIRECT_PORT,
          waitForCallback: async () => ({ code: 'c', state: capturedState }),
          shutdown: () => {},
        }
      }) as typeof startLoopbackListener,
    })

    expect(receivedPort).toBe(DEFAULT_CLERK_REDIRECT_PORT)
  })

  it('honors caller-supplied redirectPort', async () => {
    let receivedPort: number | undefined
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', id_token: 'id', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    let capturedState = ''
    await runClerkPkce({
      issuer: 'https://x.clerk.accounts.dev',
      clientId: 'cccollab-cli',
      redirectPort: 54321,
      onAuthorizeUrl: (url) => {
        capturedState = new URL(url).searchParams.get('state') ?? ''
      },
      fetchImpl: fetchMock,
      startListenerImpl: (async (timeoutMs: number, port?: number) => {
        receivedPort = port
        return {
          port: 54321,
          waitForCallback: async () => ({ code: 'c', state: capturedState }),
          shutdown: () => {},
        }
      }) as typeof startLoopbackListener,
    })

    expect(receivedPort).toBe(54321)
  })
})

describe('error message redaction', () => {
  const SECRET_ACCESS = 'super-secret-access-token-value-DO-NOT-LEAK'
  const SECRET_REFRESH = 'super-secret-refresh-token-value-DO-NOT-LEAK'
  const SECRET_ID = 'super-secret-id-token-value-DO-NOT-LEAK'

  it('exchangeCodeForTokens does not leak token fields on malformed response', async () => {
    // Malformed: access_token present but expires_in is the wrong type, so
    // the shape guard throws. The error message must not contain the token.
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          access_token: SECRET_ACCESS,
          refresh_token: SECRET_REFRESH,
          id_token: SECRET_ID,
          expires_in: 'not-a-number',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    try {
      await exchangeCodeForTokens(
        {
          issuer: 'https://x.clerk.accounts.dev',
          clientId: 'cccollab-cli',
          redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
          code: 'auth-code',
          codeVerifier: 'verifier',
        },
        fetchMock,
      )
      throw new Error('expected exchangeCodeForTokens to throw')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain(SECRET_ACCESS)
      expect(msg).not.toContain(SECRET_REFRESH)
      expect(msg).not.toContain(SECRET_ID)
      expect(msg).toContain('<redacted>')
    }
  })

  it('refreshAccessToken does not leak token fields on malformed response', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          access_token: SECRET_ACCESS,
          refresh_token: SECRET_REFRESH,
          id_token: SECRET_ID,
          expires_in: 'not-a-number',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch

    try {
      await refreshAccessToken(
        { issuer: 'https://x.clerk.accounts.dev', clientId: 'cccollab-cli', refreshToken: 'rt' },
        fetchMock,
      )
      throw new Error('expected refreshAccessToken to throw')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain(SECRET_ACCESS)
      expect(msg).not.toContain(SECRET_REFRESH)
      expect(msg).not.toContain(SECRET_ID)
      expect(msg).toContain('<redacted>')
    }
  })
})

describe('TLS enforcement on Bearer-token endpoints', () => {
  it('exchangeCodeForTokens rejects a non-HTTPS Clerk issuer (public host)', async () => {
    // fetch must NOT be called: the guard fires before the network hop.
    const fetchMock = (async () => {
      throw new Error('fetch should not be reached')
    }) as typeof fetch

    await expect(
      exchangeCodeForTokens(
        {
          issuer: 'http://evil.example.com',
          clientId: 'cccollab-cli',
          redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
          code: 'auth-code',
          codeVerifier: 'verifier',
        },
        fetchMock,
      ),
    ).rejects.toThrow(/Refusing to send Bearer token to a non-HTTPS endpoint/)
  })

  it('refreshAccessToken rejects a non-HTTPS Clerk issuer (public host)', async () => {
    const fetchMock = (async () => {
      throw new Error('fetch should not be reached')
    }) as typeof fetch

    await expect(
      refreshAccessToken(
        { issuer: 'http://evil.example.com', clientId: 'cccollab-cli', refreshToken: 'rt' },
        fetchMock,
      ),
    ).rejects.toThrow(/Refusing to send Bearer token to a non-HTTPS endpoint/)
  })
})
