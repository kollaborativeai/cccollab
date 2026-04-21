import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness.js'
import { api } from '../../convex/_generated/api.js'
import { sha256Base64Url } from '../../convex/lib/crypto.js'

describe('Scenario: OAuth 2.1 flow (CCC-22 AC: external user completes OAuth to connect their AI)', () => {
  it('client can register, obtain auth code, exchange for tokens, then refresh tokens', async () => {
    const { t, ensureUser } = makeHarness()
    const userId = await ensureUser('clerk_alice', 'Alice', 'alice@example.com')

    // 1. Dynamic Client Registration
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'Claude.ai (scenario)',
      redirectUris: ['http://localhost:9999/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    expect(client.client_id).toMatch(/^[A-Za-z0-9_-]+$/)

    // 2. Authorization (code issuance) — the human is already authenticated
    //    in our harness (we pass userId directly).
    const verifier = 'super-secret-pkce-verifier-abc123xyz'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:9999/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    expect(code).toBeTruthy()

    // 3. Token exchange
    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:9999/cb',
    })
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()
    expect(tokens.expires_in).toBeGreaterThan(0)

    // 4. Refresh produces a new access+refresh token and invalidates the old refresh
    const refreshed = await t.action(api.oauth.token.refreshAccessToken, {
      clientId: client.client_id,
      refreshToken: tokens.refresh_token,
    })
    expect(refreshed.access_token).not.toBe(tokens.access_token)
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)

    await expect(
      t.action(api.oauth.token.refreshAccessToken, {
        clientId: client.client_id,
        refreshToken: tokens.refresh_token,
      }),
    ).rejects.toThrow(/invalid|expired/i)
  })

  it('rejects code exchange with a forged PKCE verifier', async () => {
    const { t, ensureUser } = makeHarness()
    const userId = await ensureUser('clerk_alice', 'Alice')
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:9999/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const challenge = await sha256Base64Url('correct-verifier')
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:9999/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: 'wrong-verifier',
        redirectUri: 'http://localhost:9999/cb',
      }),
    ).rejects.toThrow(/pkce|verifier/i)
  })

  it('rejects an auth code being exchanged twice (single-use)', async () => {
    const { t, ensureUser } = makeHarness()
    const userId = await ensureUser('clerk_alice', 'Alice')
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:9999/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const verifier = 'verifier123'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:9999/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:9999/cb',
    })
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: verifier,
        redirectUri: 'http://localhost:9999/cb',
      }),
    ).rejects.toThrow(/invalid|expired/i)
  })

  it('registers a confidential client with a client_secret when requested', async () => {
    const { t } = makeHarness()
    const result = await t.mutation(api.oauth.register.register, {
      clientName: 'Confidential AI client',
      redirectUris: ['https://ai.example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    })
    expect(result.client_secret).toBeDefined()
    expect(result.client_secret!.length).toBeGreaterThan(20)
  })
})
