import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'

import { api } from '../_generated/api'
import schema from '../schema'
import { sha256Base64Url } from '../lib/crypto'
import { identityFor, seedUser } from './helpers'

const modules = import.meta.glob('../**/*.ts')

describe('oauth.register', () => {
  it('registers a public client and returns client_id', async () => {
    const t = convexTest(schema, modules)
    const result = await t.mutation(api.oauth.register.register, {
      clientName: 'Claude.ai',
      redirectUris: ['http://127.0.0.1:8765/callback'],
      tokenEndpointAuthMethod: 'none',
    })
    expect(result.client_id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(result.client_name).toBe('Claude.ai')
    expect(result.redirect_uris).toEqual(['http://127.0.0.1:8765/callback'])
    expect(result.token_endpoint_auth_method).toBe('none')
    expect(result.client_secret).toBeUndefined()
  })

  it('registers a confidential client and returns client_secret (once)', async () => {
    const t = convexTest(schema, modules)
    const result = await t.mutation(api.oauth.register.register, {
      clientName: 'Confidential AI',
      redirectUris: ['https://app.example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    })
    expect(result.client_secret).toBeDefined()
    expect(result.client_secret!.length).toBeGreaterThan(20)
  })

  it('rejects empty redirect_uris list', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.oauth.register.register, {
        clientName: 'x',
        redirectUris: [],
        tokenEndpointAuthMethod: 'none',
      }),
    ).rejects.toThrow(/INVALID_CLIENT_METADATA|redirect_uris/)
  })

  it('rejects non-https non-loopback redirect_uri', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.oauth.register.register, {
        clientName: 'x',
        redirectUris: ['http://evil.example.com/cb'],
        tokenEndpointAuthMethod: 'none',
      }),
    ).rejects.toThrow(/https|127\.0\.0\.1/)
  })

  it('rejects redirect_uri with a userinfo component', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.oauth.register.register, {
        clientName: 'x',
        redirectUris: ['http://attacker.com@127.0.0.1:1234/cb'],
        tokenEndpointAuthMethod: 'none',
      }),
    ).rejects.toThrow(/userinfo/)
  })

  it('rejects localhost in redirect_uri (explicit 127.0.0.1 only)', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.oauth.register.register, {
        clientName: 'x',
        redirectUris: ['http://localhost:8765/cb'],
        tokenEndpointAuthMethod: 'none',
      }),
    ).rejects.toThrow(/127\.0\.0\.1/)
  })
})

describe('oauth.authorize + token', () => {
  async function setupClient(t: ReturnType<typeof convexTest>, method: 'none' | 'client_secret_post' = 'none') {
    return await t.mutation(api.oauth.register.register, {
      clientName: 'Test AI',
      redirectUris: ['http://127.0.0.1:8765/cb'],
      tokenEndpointAuthMethod: method,
    })
  }

  async function issueCode(
    t: ReturnType<typeof convexTest>,
    userId: Awaited<ReturnType<typeof seedUser>>,
    clientId: string,
    verifier: string,
  ) {
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
      clientId,
      redirectUri: 'http://127.0.0.1:8765/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
    })
    return code
  }

  it('full flow: register -> authorize -> exchange -> refresh', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await setupClient(t)
    const verifier = 'verifier-abcdef0123456789abcdef0123456789'
    const code = await issueCode(t, userId, client.client_id, verifier)

    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.access_token.length).toBeGreaterThan(20)
    expect(tokens.refresh_token.length).toBeGreaterThan(20)
    expect(tokens.scope).toBe('cccollab:topics.rw')

    const refreshed = await t.action(api.oauth.token.refreshAccessToken, {
      clientId: client.client_id,
      refreshToken: tokens.refresh_token,
    })
    expect(refreshed.access_token).not.toBe(tokens.access_token)
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)

    // Original refresh token is now revoked
    await expect(
      t.action(api.oauth.token.refreshAccessToken, {
        clientId: client.client_id,
        refreshToken: tokens.refresh_token,
      }),
    ).rejects.toThrow(/revoked|invalid|expired/i)
  })

  it('authorize requires an authenticated user', async () => {
    const t = convexTest(schema, modules)
    const client = await setupClient(t)
    // Not calling `withIdentity` — the mutation should reject.
    await expect(
      t.mutation(api.oauth.authorize.issueAuthCode, {
        clientId: client.client_id,
        redirectUri: 'http://127.0.0.1:8765/cb',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        scope: 'cccollab:topics.rw',
      }),
    ).rejects.toThrow(/UNAUTHENTICATED/)
  })

  it('authorize rejects unknown client_id', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    await expect(
      t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
        clientId: 'ghost',
        redirectUri: 'http://127.0.0.1:8765/cb',
        codeChallenge: 'x',
        codeChallengeMethod: 'S256',
        scope: 'cccollab:topics.rw',
      }),
    ).rejects.toThrow(/UNKNOWN_CLIENT/)
  })

  it('authorize rejects unknown scope', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await setupClient(t)
    await expect(
      t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
        clientId: client.client_id,
        redirectUri: 'http://127.0.0.1:8765/cb',
        codeChallenge: 'x',
        codeChallengeMethod: 'S256',
        scope: 'admin',
      }),
    ).rejects.toThrow(/INVALID_SCOPE|scope/)
  })

  it('token exchange rejects mismatched PKCE verifier', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await setupClient(t)
    const code = await issueCode(t, userId, client.client_id, 'right-verifier')
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: 'wrong-verifier',
        redirectUri: 'http://127.0.0.1:8765/cb',
      }),
    ).rejects.toThrow(/pkce|verifier|INVALID_GRANT/i)
  })

  it('token exchange rejects code being used twice', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await setupClient(t)
    const verifier = 'verifier-abcdef0123456789abcdef0123456789'
    const code = await issueCode(t, userId, client.client_id, verifier)
    await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'http://127.0.0.1:8765/cb',
      }),
    ).rejects.toThrow(/invalid|expired|INVALID_GRANT/i)
  })

  it('confidential client rejects missing client_secret', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await setupClient(t, 'client_secret_post')
    const verifier = 'verifier-abcdef0123456789abcdef0123456789'
    const code = await issueCode(t, userId, client.client_id, verifier)
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'http://127.0.0.1:8765/cb',
      }),
    ).rejects.toThrow(/client_secret|INVALID_CLIENT/)
  })

  it('confidential client rejects wrong client_secret', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await setupClient(t, 'client_secret_post')
    const verifier = 'verifier-abcdef0123456789abcdef0123456789'
    const code = await issueCode(t, userId, client.client_id, verifier)
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        clientSecret: 'wrong-secret-value',
        code,
        codeVerifier: verifier,
        redirectUri: 'http://127.0.0.1:8765/cb',
      }),
    ).rejects.toThrow(/client_secret|INVALID_CLIENT/)
  })

  it('confidential client accepts correct client_secret', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await setupClient(t, 'client_secret_post')
    const verifier = 'verifier-abcdef0123456789abcdef0123456789'
    const code = await issueCode(t, userId, client.client_id, verifier)
    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })
    expect(tokens.access_token.length).toBeGreaterThan(20)
  })

  it('token exchange creates a synthetic session bound to the user', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions', 'Alice')
    const client = await setupClient(t)
    const verifier = 'verifier-abcdef0123456789abcdef0123456789'
    const code = await issueCode(t, userId, client.client_id, verifier)
    await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      clientName: 'Claude.ai',
      code,
      codeVerifier: verifier,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })
    const sessions = await t.run(async (ctx) =>
      ctx.db
        .query('sessions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    )
    expect(sessions.length).toBe(1)
    expect(sessions[0]!.sessionName).toContain('Claude.ai')
    expect(sessions[0]!.sessionName).toContain('external')
  })

  it('refresh reuses the same synthetic session across rotations', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions', 'Alice')
    const client = await setupClient(t)
    const verifier = 'verifier-abcdef0123456789abcdef0123456789'
    const code = await issueCode(t, userId, client.client_id, verifier)
    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      clientName: 'Claude.ai',
      code,
      codeVerifier: verifier,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })
    await t.action(api.oauth.token.refreshAccessToken, {
      clientId: client.client_id,
      refreshToken: tokens.refresh_token,
    })
    const sessions = await t.run(async (ctx) =>
      ctx.db
        .query('sessions')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    )
    expect(sessions.length).toBe(1)
  })

  it('token endpoint rejects non-form-encoded Content-Type (via HTTP route)', async () => {
    // Smoke-test the content-type check by exercising the HTTP action directly.
    const t = convexTest(schema, modules)
    const res = await t.fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; error_description?: string }
    expect(body.error).toBe('invalid_request')
  })
})

describe('oauth token exchange — validation order + re-auth hygiene', () => {
  async function freshCode(t: ReturnType<typeof convexTest>) {
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'Test AI',
      redirectUris: ['http://127.0.0.1:8765/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const verifier = 'verifier-0123456789abcdef0123456789abcdef'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:8765/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
    })
    return { userId, clientId: client.client_id, code, verifier }
  }

  it('wrong code_verifier does NOT burn the code — retry with correct verifier succeeds', async () => {
    const t = convexTest(schema, modules)
    const { clientId, code, verifier } = await freshCode(t)
    // First attempt with wrong verifier should fail.
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId,
        code,
        codeVerifier: 'wrong-verifier',
        redirectUri: 'http://127.0.0.1:8765/cb',
      }),
    ).rejects.toThrow(/pkce|INVALID_GRANT/i)
    // The code must still be usable — a legitimate retry succeeds.
    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })
    expect(tokens.access_token).toBeTruthy()
  })

  it('wrong redirect_uri does NOT burn the code either', async () => {
    const t = convexTest(schema, modules)
    const { clientId, code, verifier } = await freshCode(t)
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId,
        code,
        codeVerifier: verifier,
        redirectUri: 'http://127.0.0.1:9999/other',
      }),
    ).rejects.toThrow(/redirect|INVALID_GRANT/i)
    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })
    expect(tokens.access_token).toBeTruthy()
  })

  it('re-authorize revokes the prior access + refresh tokens', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'Claude.ai',
      redirectUris: ['http://127.0.0.1:8765/cb'],
      tokenEndpointAuthMethod: 'none',
    })

    // First authorize + exchange.
    const verifier1 = 'verifier-first-0123456789abcdef0123456789'
    const challenge1 = await sha256Base64Url(verifier1)
    const { code: code1 } = await t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:8765/cb',
      codeChallenge: challenge1,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
    })
    const tokens1 = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code: code1,
      codeVerifier: verifier1,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })

    // Second authorize + exchange (same user, same client) — should revoke tokens1.
    const verifier2 = 'verifier-second-0123456789abcdef0123456789'
    const challenge2 = await sha256Base64Url(verifier2)
    const { code: code2 } = await t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://127.0.0.1:8765/cb',
      codeChallenge: challenge2,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
    })
    await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code: code2,
      codeVerifier: verifier2,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })

    // tokens1.access_token should now be revoked.
    const access = await t.run(async (ctx) =>
      ctx.db
        .query('oauthAccessTokens')
        .withIndex('by_token', (q) => q.eq('token', tokens1.access_token))
        .unique(),
    )
    expect(access?.revoked).toBe(true)

    // tokens1.refresh_token should also be revoked.
    const refresh = await t.run(async (ctx) =>
      ctx.db
        .query('oauthRefreshTokens')
        .withIndex('by_token', (q) => q.eq('token', tokens1.refresh_token))
        .unique(),
    )
    expect(refresh?.revoked).toBe(true)
  })

  it('two sequential exchanges for different codes / same (userId, clientId) leave only one valid access token', async () => {
    // Sequential-correctness test (not a true concurrency test).
    //
    // convex-test serialises mutations — Promise.all-wrapped t.action
    // calls don't actually interleave at the database layer; the second
    // mutation runs after the first has fully committed. So this test
    // proves the "later exchange revokes earlier tokens" invariant, not
    // the concurrent-OCC behaviour.
    //
    // The true concurrent-race defence lives in production: the
    // `oauthGrants` sentinel row read+patched inside
    // `exchangeCodeForTokens` makes two real-parallel mutations conflict
    // on a shared document, so Convex OCC retries the later one — at
    // which point this sequential test's revoke logic kicks in.
    //
    // Verifying the true-OCC behaviour requires a real Convex
    // integration environment (not convex-test), which is out of scope
    // for this test file.
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions', 'Alice')
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'Claude.ai',
      redirectUris: ['http://127.0.0.1:8765/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    // Mint two auth codes concurrently.
    const verifier1 = 'verifier-aaa-0123456789abcdef0123456789'
    const verifier2 = 'verifier-bbb-0123456789abcdef0123456789'
    const [auth1, auth2] = await Promise.all([
      t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
        clientId: client.client_id,
        redirectUri: 'http://127.0.0.1:8765/cb',
        codeChallenge: await sha256Base64Url(verifier1),
        codeChallengeMethod: 'S256',
        scope: 'cccollab:topics.rw',
      }),
      t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
        clientId: client.client_id,
        redirectUri: 'http://127.0.0.1:8765/cb',
        codeChallenge: await sha256Base64Url(verifier2),
        codeChallengeMethod: 'S256',
        scope: 'cccollab:topics.rw',
      }),
    ])

    // Exchange both codes concurrently.
    const [tokens1, tokens2] = await Promise.all([
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code: auth1.code,
        codeVerifier: verifier1,
        redirectUri: 'http://127.0.0.1:8765/cb',
      }),
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code: auth2.code,
        codeVerifier: verifier2,
        redirectUri: 'http://127.0.0.1:8765/cb',
      }),
    ])

    // The invariant: at most one of the two emitted access tokens is
    // still valid after both flows finish. The later-committing mutation
    // observes the earlier's tokens during its revoke step and marks
    // them revoked.
    const access1 = await t.run(async (ctx) =>
      ctx.db
        .query('oauthAccessTokens')
        .withIndex('by_token', (q) => q.eq('token', tokens1.access_token))
        .unique(),
    )
    const access2 = await t.run(async (ctx) =>
      ctx.db
        .query('oauthAccessTokens')
        .withIndex('by_token', (q) => q.eq('token', tokens2.access_token))
        .unique(),
    )
    const validCount = [access1, access2].filter((r) => r && !r.revoked).length
    expect(validCount).toBe(1)
  })

  it('re-authorize leaves tokens for a DIFFERENT client of the same user alone', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions')
    const clientA = await t.mutation(api.oauth.register.register, {
      clientName: 'Claude.ai',
      redirectUris: ['http://127.0.0.1:8765/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const clientB = await t.mutation(api.oauth.register.register, {
      clientName: 'Cursor',
      redirectUris: ['http://127.0.0.1:8766/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    // Authorize client A.
    const verifierA = 'verifier-a-0123456789abcdef0123456789'
    const { code: codeA } = await t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
      clientId: clientA.client_id,
      redirectUri: 'http://127.0.0.1:8765/cb',
      codeChallenge: await sha256Base64Url(verifierA),
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
    })
    const tokensA = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: clientA.client_id,
      code: codeA,
      codeVerifier: verifierA,
      redirectUri: 'http://127.0.0.1:8765/cb',
    })
    // Now authorize client B (different client, same user) — tokensA must remain valid.
    const verifierB = 'verifier-b-0123456789abcdef0123456789'
    const { code: codeB } = await t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
      clientId: clientB.client_id,
      redirectUri: 'http://127.0.0.1:8766/cb',
      codeChallenge: await sha256Base64Url(verifierB),
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
    })
    await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: clientB.client_id,
      code: codeB,
      codeVerifier: verifierB,
      redirectUri: 'http://127.0.0.1:8766/cb',
    })

    const accessA = await t.run(async (ctx) =>
      ctx.db
        .query('oauthAccessTokens')
        .withIndex('by_token', (q) => q.eq('token', tokensA.access_token))
        .unique(),
    )
    expect(accessA?.revoked).toBe(false)
  })
})

describe('oauth metadata', () => {
  it('authServerMetadata reflects baseUrl across endpoints', async () => {
    const { authServerMetadata } = await import('../oauth/metadata')
    const m = authServerMetadata('https://example.com')
    expect(m.issuer).toBe('https://example.com')
    expect(m.authorization_endpoint).toBe('https://example.com/authorize')
    expect(m.token_endpoint).toBe('https://example.com/token')
    expect(m.registration_endpoint).toBe('https://example.com/register')
    expect(m.code_challenge_methods_supported).toEqual(['S256'])
    expect(m.scopes_supported).toContain('cccollab:topics.rw')
  })

  it('protectedResourceMetadata points at /mcp', async () => {
    const { protectedResourceMetadata } = await import('../oauth/metadata')
    const m = protectedResourceMetadata('https://example.com')
    expect(m.resource).toBe('https://example.com/mcp')
    expect(m.authorization_servers).toEqual(['https://example.com'])
    expect(m.bearer_methods_supported).toEqual(['header'])
  })
})
