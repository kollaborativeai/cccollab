import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  generateCodeVerifier,
  deriveCodeChallenge,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  runClerkPkce,
  DEFAULT_CLERK_REDIRECT_PORT,
  CLERK_CONVEX_AUDIENCE,
  exchangeOAuthTokenForConvexJwt,
  ConvexJwtExchangeError,
  deploymentUrlToHttpActionUrl,
} from '../../src/remote/auth-clerk.js'
import type { startLoopbackListener } from '../../src/remote/auth.js'

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
    expect(u.searchParams.has('resource')).toBe(false)
  })

  it('includes resource param when provided (RFC 8707)', () => {
    const url = buildAuthorizeUrl({
      issuer: 'https://x.clerk.accounts.dev',
      clientId: 'cccollab-cli',
      redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
      codeChallenge: 'abc123',
      state: 'state-xyz',
      resource: CLERK_CONVEX_AUDIENCE,
    })
    expect(new URL(url).searchParams.get('resource')).toBe('convex')
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

  it('includes resource in the form body when provided (RFC 8707)', async () => {
    const captured: { body: string } = { body: '' }
    const fetchMock = (async (_url: string, init: RequestInit) => {
      captured.body = init.body as string
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await exchangeCodeForTokens(
      {
        issuer: 'https://x.clerk.accounts.dev',
        clientId: 'cccollab-cli',
        redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
        code: 'c',
        codeVerifier: 'v',
        resource: CLERK_CONVEX_AUDIENCE,
      },
      fetchMock,
    )
    expect(new URLSearchParams(captured.body).get('resource')).toBe('convex')
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

  it('includes resource in the form body when provided (RFC 8707)', async () => {
    const captured: { body: string } = { body: '' }
    const fetchMock = (async (_url: string, init: RequestInit) => {
      captured.body = init.body as string
      return new Response(JSON.stringify({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await refreshAccessToken(
      {
        issuer: 'https://x.clerk.accounts.dev',
        clientId: 'cccollab-cli',
        refreshToken: 'old_rt',
        resource: CLERK_CONVEX_AUDIENCE,
      },
      fetchMock,
    )
    expect(new URLSearchParams(captured.body).get('resource')).toBe('convex')
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
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }), {
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
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }), {
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

  it('threads resource through to both authorize URL and token exchange', async () => {
    let capturedAuthorizeUrl = ''
    const tokenCalls: { body: string }[] = []
    const fetchMock = (async (_url: string, init: RequestInit) => {
      tokenCalls.push({ body: init.body as string })
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    let capturedState = ''
    await runClerkPkce({
      issuer: 'https://x.clerk.accounts.dev',
      clientId: 'cccollab-cli',
      resource: CLERK_CONVEX_AUDIENCE,
      onAuthorizeUrl: (url) => {
        capturedAuthorizeUrl = url
        capturedState = new URL(url).searchParams.get('state') ?? ''
      },
      fetchImpl: fetchMock,
      startListenerImpl: (async () => ({
        port: DEFAULT_CLERK_REDIRECT_PORT,
        waitForCallback: async () => ({ code: 'c', state: capturedState }),
        shutdown: () => {},
      })) as typeof startLoopbackListener,
    })

    expect(new URL(capturedAuthorizeUrl).searchParams.get('resource')).toBe('convex')
    expect(tokenCalls).toHaveLength(1)
    const firstCall = tokenCalls[0]
    expect(firstCall).toBeDefined()
    expect(new URLSearchParams(firstCall?.body ?? '').get('resource')).toBe('convex')
  })
})

describe('deploymentUrlToHttpActionUrl', () => {
  it('swaps .convex.cloud → .convex.site on the hostname', () => {
    expect(deploymentUrlToHttpActionUrl('https://clear-yak-990.convex.cloud')).toBe('https://clear-yak-990.convex.site')
  })

  it('preserves the scheme and slug exactly', () => {
    expect(deploymentUrlToHttpActionUrl('https://wonderful-narwhal-409.convex.cloud')).toBe(
      'https://wonderful-narwhal-409.convex.site',
    )
  })

  it('strips trailing slash from the output', () => {
    expect(deploymentUrlToHttpActionUrl('https://x.convex.cloud/')).toBe('https://x.convex.site')
  })

  it('passes non-.convex.cloud URLs through unchanged (self-hosted, tests)', () => {
    expect(deploymentUrlToHttpActionUrl('https://convex.example.com')).toBe('https://convex.example.com')
    expect(deploymentUrlToHttpActionUrl('http://127.0.0.1:8001')).toBe('http://127.0.0.1:8001')
  })

  it('only matches .convex.cloud as a suffix, not a substring', () => {
    expect(deploymentUrlToHttpActionUrl('https://foo.convex.cloud.example.com')).toBe(
      'https://foo.convex.cloud.example.com',
    )
  })
})

describe('exchangeOAuthTokenForConvexJwt', () => {
  it('POSTs to /cccollab/exchangeToken with Bearer auth and returns parsed result', async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = []
    const futureExpiresAt = Date.now() + 60_000
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method as string,
        headers: init.headers as Record<string, string>,
      })
      return new Response(JSON.stringify({ jwt: 'cv-jwt-abc', expiresAt: futureExpiresAt }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const result = await exchangeOAuthTokenForConvexJwt(
      { kaiUrl: 'https://x.convex.cloud', oauthToken: 'oauth-token-123' },
      fetchMock,
    )

    expect(result.jwt).toBe('cv-jwt-abc')
    expect(result.expiresAt).toBe(futureExpiresAt)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call).toBeDefined()
    // Convex HTTP actions are served on .convex.site, not .convex.cloud —
    // deploymentUrlToHttpActionUrl translates the input URL.
    expect(call?.url).toBe('https://x.convex.site/cccollab/exchangeToken')
    expect(call?.method).toBe('POST')
    expect(call?.headers['Authorization']).toBe('Bearer oauth-token-123')
  })

  it('throws ConvexJwtExchangeError with INVALID_OAUTH_TOKEN code on 401', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ code: 'INVALID_OAUTH_TOKEN', message: 'Token verification failed' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await expect(
      exchangeOAuthTokenForConvexJwt({ kaiUrl: 'https://x.convex.cloud', oauthToken: 'bad-token' }, fetchMock),
    ).rejects.toSatisfy((err) => {
      return (
        err instanceof ConvexJwtExchangeError &&
        err.code === 'INVALID_OAUTH_TOKEN' &&
        err.name === 'ConvexJwtExchangeError'
      )
    })
  })

  it('maps unknown 401 codes to EXCHANGE_FAILED', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ code: 'SOME_UNKNOWN_ERROR', message: 'Something went wrong' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await expect(
      exchangeOAuthTokenForConvexJwt({ kaiUrl: 'https://x.convex.cloud', oauthToken: 'token' }, fetchMock),
    ).rejects.toSatisfy((err) => {
      return err instanceof ConvexJwtExchangeError && err.code === 'EXCHANGE_FAILED'
    })
  })

  it('throws on malformed response shape (missing jwt or expiresAt)', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ something: 'else' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await expect(
      exchangeOAuthTokenForConvexJwt({ kaiUrl: 'https://x.convex.cloud', oauthToken: 'token' }, fetchMock),
    ).rejects.toThrow(/Unexpected \/cccollab\/exchangeToken response shape/)
  })

  it.each([
    ['MISSING_AUTH_HEADER', 401],
    ['NO_ACTIVE_SESSION', 401],
    ['TEMPLATE_RESPONSE_INVALID', 500],
    ['SERVER_MISCONFIGURED', 500],
    ['UPSTREAM_RATE_LIMITED', 429],
    ['UPSTREAM_UNAVAILABLE', 503],
  ] as const)('preserves the %s code from KAI (status %i)', async (code, status) => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ code, message: `synthetic ${code}` }), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    await expect(
      exchangeOAuthTokenForConvexJwt({ kaiUrl: 'https://x.convex.cloud', oauthToken: 'token' }, fetchMock),
    ).rejects.toSatisfy((err) => err instanceof ConvexJwtExchangeError && err.code === code)
  })
})

describe('error message redaction', () => {
  const SECRET_ACCESS = 'super-secret-access-token-value-DO-NOT-LEAK'
  const SECRET_REFRESH = 'super-secret-refresh-token-value-DO-NOT-LEAK'
  const SECRET_ID = 'super-secret-id-token-value-DO-NOT-LEAK'
  const SECRET_JWT = 'super-secret-jwt-value-DO-NOT-LEAK'

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
        JSON.stringify({ access_token: SECRET_ACCESS, refresh_token: SECRET_REFRESH, expires_in: 'not-a-number' }),
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
      expect(msg).toContain('<redacted>')
    }
  })

  it('exchangeOAuthTokenForConvexJwt does not leak jwt on malformed response', async () => {
    // Malformed: jwt present as the wrong type-shape (expiresAt missing).
    const fetchMock = (async () =>
      new Response(JSON.stringify({ jwt: SECRET_JWT, somethingElse: 'oops' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    try {
      await exchangeOAuthTokenForConvexJwt({ kaiUrl: 'https://x.convex.cloud', oauthToken: 'token' }, fetchMock)
      throw new Error('expected exchangeOAuthTokenForConvexJwt to throw')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).not.toContain(SECRET_JWT)
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

  it('exchangeOAuthTokenForConvexJwt rejects a non-HTTPS kaiUrl (public host)', async () => {
    const fetchMock = (async () => {
      throw new Error('fetch should not be reached')
    }) as typeof fetch

    await expect(
      exchangeOAuthTokenForConvexJwt({ kaiUrl: 'http://evil.example.com', oauthToken: 'token' }, fetchMock),
    ).rejects.toThrow(/Refusing to send Bearer token to a non-HTTPS endpoint/)
  })

  it.each(['http://127.0.0.1:8001', 'http://localhost:8001', 'http://[::1]:8001'])(
    'allows loopback host %s over plaintext (local dev / tests)',
    async (kaiUrl) => {
      let called = false
      const fetchMock = (async () => {
        called = true
        return new Response(JSON.stringify({ jwt: 'j', expiresAt: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch

      await exchangeOAuthTokenForConvexJwt({ kaiUrl, oauthToken: 'token' }, fetchMock)
      expect(called).toBe(true)
    },
  )

  it('allows HTTPS public host (the production case)', async () => {
    let called = false
    const fetchMock = (async () => {
      called = true
      return new Response(JSON.stringify({ jwt: 'j', expiresAt: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    await exchangeOAuthTokenForConvexJwt({ kaiUrl: 'https://x.convex.cloud', oauthToken: 'token' }, fetchMock)
    expect(called).toBe(true)
  })
})
