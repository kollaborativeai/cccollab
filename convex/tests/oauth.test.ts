import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema.js'
import { api } from '../_generated/api.js'
import { sha256Base64Url } from '../lib/crypto.js'

const modules = import.meta.glob('../**/*.*s')

describe('oauth dynamic client registration', () => {
  it('registers a public client (none auth method) and returns client_id', async () => {
    const t = convexTest(schema, modules)
    const result = await t.mutation(api.oauth.register.register, {
      clientName: 'Test AI Client',
      redirectUris: ['http://localhost:8765/callback'],
      tokenEndpointAuthMethod: 'none',
    })
    expect(result.client_id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(result.client_name).toBe('Test AI Client')
    expect(result.redirect_uris).toEqual(['http://localhost:8765/callback'])
    expect(result.token_endpoint_auth_method).toBe('none')
    expect(result.client_secret).toBeUndefined()
  })

  it('registers a confidential client and returns a client_secret', async () => {
    const t = convexTest(schema, modules)
    const result = await t.mutation(api.oauth.register.register, {
      clientName: 'Confidential AI',
      redirectUris: ['https://example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    })
    expect(result.client_secret).toBeDefined()
    expect(result.client_secret!.length).toBeGreaterThan(20)
  })

  it('rejects redirect_uris with empty list', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.oauth.register.register, {
        clientName: 'x',
        redirectUris: [],
        tokenEndpointAuthMethod: 'none',
      }),
    ).rejects.toThrow(/redirect_uris/i)
  })

  it('rejects non-https, non-localhost redirect_uri', async () => {
    const t = convexTest(schema, modules)
    await expect(
      t.mutation(api.oauth.register.register, {
        clientName: 'x',
        redirectUris: ['http://evil.example.com/cb'],
        tokenEndpointAuthMethod: 'none',
      }),
    ).rejects.toThrow(/https/i)
  })
})

describe('oauth authorize', () => {
  it('issues an auth code bound to the user + PKCE challenge', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const challenge = await sha256Base64Url('verifier')
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:1/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects unknown client_id', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    await expect(
      t.mutation(api.oauth.authorize.issueAuthCode, {
        clientId: 'ghost',
        redirectUri: 'http://localhost:1/cb',
        codeChallenge: 'c',
        codeChallengeMethod: 'S256',
        scope: 'cccollab:topics.rw',
        userId,
      }),
    ).rejects.toThrow(/unknown client/i)
  })

  it('rejects redirect_uri not matching registration', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    await expect(
      t.mutation(api.oauth.authorize.issueAuthCode, {
        clientId: client.client_id,
        redirectUri: 'http://evil.example/cb',
        codeChallenge: 'c',
        codeChallengeMethod: 'S256',
        scope: 'cccollab:topics.rw',
        userId,
      }),
    ).rejects.toThrow(/redirect/i)
  })
})

describe('oauth token exchange', () => {
  async function setupAndGetCode(t: ReturnType<typeof convexTest>) {
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const verifier = 'abcdef0123456789abcdef0123456789abcdef0123456789'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:1/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    return { userId, client, verifier, code }
  }

  it('exchanges code + verifier for access + refresh tokens', async () => {
    const t = convexTest(schema, modules)
    const { client, verifier, code } = await setupAndGetCode(t)
    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:1/cb',
    })
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.access_token.length).toBeGreaterThan(20)
    expect(tokens.refresh_token.length).toBeGreaterThan(20)
    expect(tokens.expires_in).toBeGreaterThan(0)
    expect(tokens.scope).toBe('cccollab:topics.rw')
  })

  it('rejects exchange with wrong PKCE verifier', async () => {
    const t = convexTest(schema, modules)
    const { client, code } = await setupAndGetCode(t)
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: 'not-the-right-verifier',
        redirectUri: 'http://localhost:1/cb',
      }),
    ).rejects.toThrow(/pkce|verifier/i)
  })

  it('rejects a code that has already been consumed', async () => {
    const t = convexTest(schema, modules)
    const { client, verifier, code } = await setupAndGetCode(t)
    await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:1/cb',
    })
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'http://localhost:1/cb',
      }),
    ).rejects.toThrow(/invalid|expired/i)
  })

  it('refresh_token mints a new access + refresh token', async () => {
    const t = convexTest(schema, modules)
    const { client, verifier, code } = await setupAndGetCode(t)
    const first = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:1/cb',
    })
    const refreshed = await t.action(api.oauth.token.refreshAccessToken, {
      clientId: client.client_id,
      refreshToken: first.refresh_token,
    })
    expect(refreshed.access_token).not.toBe(first.access_token)
    expect(refreshed.refresh_token).not.toBe(first.refresh_token)
  })

  it('refresh_token rejects used tokens', async () => {
    const t = convexTest(schema, modules)
    const { client, verifier, code } = await setupAndGetCode(t)
    const first = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:1/cb',
    })
    await t.action(api.oauth.token.refreshAccessToken, {
      clientId: client.client_id,
      refreshToken: first.refresh_token,
    })
    await expect(
      t.action(api.oauth.token.refreshAccessToken, {
        clientId: client.client_id,
        refreshToken: first.refresh_token,
      }),
    ).rejects.toThrow(/invalid|expired/i)
  })
})

describe('oauth confidential client auth', () => {
  it('exchange rejects confidential client without client_secret', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'confidential',
      redirectUris: ['https://app.example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    })
    const verifier = 'verifier-xyz-1234567890abcdef'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'https://app.example.com/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'https://app.example.com/cb',
      }),
    ).rejects.toThrow(/client_secret required/i)
  })

  it('exchange rejects confidential client with wrong client_secret', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'confidential',
      redirectUris: ['https://app.example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    })
    const verifier = 'verifier-xyz-1234567890abcdef'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'https://app.example.com/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        clientSecret: 'bogus-secret-value',
        code,
        codeVerifier: verifier,
        redirectUri: 'https://app.example.com/cb',
      }),
    ).rejects.toThrow(/client_secret mismatch/i)
  })

  it('exchange succeeds with the correct client_secret for a confidential client', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'confidential',
      redirectUris: ['https://app.example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    })
    const verifier = 'verifier-xyz-1234567890abcdef'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'https://app.example.com/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      clientSecret: client.client_secret,
      code,
      codeVerifier: verifier,
      redirectUri: 'https://app.example.com/cb',
    })
    expect(tokens.access_token).toBeTruthy()
  })

  it('public client (none) ignores client_secret parameter', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'public',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const verifier = 'verifier-xyz-1234567890abcdef'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:1/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      clientSecret: 'totally-ignored',
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:1/cb',
    })
    expect(tokens.access_token).toBeTruthy()
  })
})

describe('oauth scope enforcement', () => {
  it('authorize rejects unknown scope', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    await expect(
      t.mutation(api.oauth.authorize.issueAuthCode, {
        clientId: client.client_id,
        redirectUri: 'http://localhost:1/cb',
        codeChallenge: 'c',
        codeChallengeMethod: 'S256',
        scope: 'admin',
        userId,
      }),
    ).rejects.toThrow(/invalid scope/i)
  })

  it('authorize rejects empty scope', async () => {
    const t = convexTest(schema, modules)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    await expect(
      t.mutation(api.oauth.authorize.issueAuthCode, {
        clientId: client.client_id,
        redirectUri: 'http://localhost:1/cb',
        codeChallenge: 'c',
        codeChallengeMethod: 'S256',
        scope: '',
        userId,
      }),
    ).rejects.toThrow(/invalid scope/i)
  })
})

describe('oauth metadata', () => {
  it('authServerMetadata reflects baseUrl for issuer + endpoints', async () => {
    const { authServerMetadata } = await import('../oauth/metadata.js')
    const m = authServerMetadata('https://example.com')
    expect(m.issuer).toBe('https://example.com')
    expect(m.authorization_endpoint).toBe('https://example.com/authorize')
    expect(m.token_endpoint).toBe('https://example.com/token')
    expect(m.registration_endpoint).toBe('https://example.com/register')
    expect(m.code_challenge_methods_supported).toEqual(['S256'])
  })

  it('protectedResourceMetadata points at /mcp', async () => {
    const { protectedResourceMetadata } = await import('../oauth/metadata.js')
    const m = protectedResourceMetadata('https://example.com')
    expect(m.resource).toBe('https://example.com/mcp')
    expect(m.authorization_servers).toEqual(['https://example.com'])
    expect(m.bearer_methods_supported).toEqual(['header'])
  })
})
