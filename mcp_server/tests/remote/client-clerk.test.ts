import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect HOME before importing modules that resolve `~/.cccollab/...`
// at module load time.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-clerk-client-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

// Dynamic imports to ensure the HOME override is in effect before the
// save module resolves CCCOLLAB_CONFIG_FILE.
const { saveLocationAuth, clearUserConfig } = await import('../../src/config/save.js')

// Partial-stub auth-clerk.js: keep the real module shape but replace
// refreshAccessToken and exchangeOAuthTokenForConvexJwt with vi.fn()s
// that tests can configure per-case.
vi.mock('../../src/remote/auth-clerk.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/remote/auth-clerk.js')>()
  return {
    ...actual,
    refreshAccessToken: vi.fn(),
    exchangeOAuthTokenForConvexJwt: vi.fn(),
  }
})

const { makeClerkAuthFetcher, makeOAuthAccessTokenProvider, CLERK_FRESHNESS_MARGIN_MS } =
  await import('../../src/remote/client.js')
const { refreshAccessToken, exchangeOAuthTokenForConvexJwt, ConvexJwtExchangeError } =
  await import('../../src/remote/auth-clerk.js')
const mockRefreshAccessToken = vi.mocked(refreshAccessToken)
const mockExchangeOAuthTokenForConvexJwt = vi.mocked(exchangeOAuthTokenForConvexJwt)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ISSUER = 'https://test.clerk.accounts.dev'
const TEST_CLIENT_ID = 'cccollab-test-client'
const TEST_URL = 'https://test.convex.cloud'
const TEST_LOCATION = 'test-location'

function freshExpiresAt(offsetMs = 60_000): number {
  return Date.now() + offsetMs
}

function staleExpiresAt(): number {
  return Date.now() - 1_000
}

function baseInit(overrides?: Partial<Parameters<typeof makeClerkAuthFetcher>[0]>) {
  return {
    locationName: TEST_LOCATION,
    url: TEST_URL,
    clerkIssuer: TEST_ISSUER,
    clerkClientId: TEST_CLIENT_ID,
    accessToken: 'initial-oauth-at',
    refreshToken: 'initial-rt',
    accessTokenExpiresAt: freshExpiresAt(),
    ...overrides,
  }
}

function defaultConvexJwtResult(overrides?: { jwt?: string; expiresAt?: number }) {
  return {
    jwt: overrides?.jwt ?? 'convex-jwt-default',
    expiresAt: overrides?.expiresAt ?? freshExpiresAt(60_000),
  }
}

// ---------------------------------------------------------------------------
// Tests: makeOAuthAccessTokenProvider (inner OAuth layer)
// ---------------------------------------------------------------------------

describe('makeOAuthAccessTokenProvider (inner OAuth layer)', () => {
  beforeEach(() => {
    clearUserConfig()
    mockRefreshAccessToken.mockReset()
  })
  afterEach(() => clearUserConfig())
  afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }))

  it('returns cached OAuth token when still fresh and forceRefresh is false', async () => {
    const { getOAuthToken } = makeOAuthAccessTokenProvider(baseInit({ accessTokenExpiresAt: freshExpiresAt(60_000) }))

    const token = await getOAuthToken({ forceRefresh: false })

    expect(token).toBe('initial-oauth-at')
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('returns cached token when expiry is exactly at the freshness margin boundary + 1ms', async () => {
    const { getOAuthToken } = makeOAuthAccessTokenProvider(
      baseInit({ accessTokenExpiresAt: Date.now() + CLERK_FRESHNESS_MARGIN_MS + 1 }),
    )

    const token = await getOAuthToken({ forceRefresh: false })

    expect(token).toBe('initial-oauth-at')
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('refreshes when token is expired (expiresAt in the past)', async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-oauth-at',
      refreshToken: 'new-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const { getOAuthToken } = makeOAuthAccessTokenProvider(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))

    const token = await getOAuthToken({ forceRefresh: false })

    expect(token).toBe('new-oauth-at')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
    expect(mockRefreshAccessToken).toHaveBeenCalledWith({
      issuer: TEST_ISSUER,
      clientId: TEST_CLIENT_ID,
      refreshToken: 'initial-rt',
      resource: 'convex',
    })
  })

  it('persists new OAuth tokens to disk after a successful refresh', async () => {
    const newExpiresAt = freshExpiresAt(3600_000)
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-oauth-at',
      refreshToken: 'new-rt',
      accessTokenExpiresAt: newExpiresAt,
    })

    const { getOAuthToken } = makeOAuthAccessTokenProvider(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))
    await getOAuthToken({ forceRefresh: false })

    const { loadPersistedLocationAuth } = await import('../../src/config/save.js')
    const onDisk = loadPersistedLocationAuth(TEST_LOCATION)
    expect(onDisk?.accessToken).toBe('new-oauth-at')
    expect(onDisk?.refreshToken).toBe('new-rt')
    expect(onDisk?.accessTokenExpiresAt).toBe(newExpiresAt)
    expect(onDisk?.authType).toBe('clerk')
  })

  it('force-refreshes OAuth when forceRefresh=true even if still fresh', async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'forced-new-oauth-at',
      refreshToken: 'forced-new-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const { getOAuthToken } = makeOAuthAccessTokenProvider(baseInit({ accessTokenExpiresAt: freshExpiresAt(60_000) }))

    const token = await getOAuthToken({ forceRefresh: true })

    expect(token).toBe('forced-new-oauth-at')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })

  it('adopts peer-process refresh from disk instead of calling refreshAccessToken', async () => {
    const peerExpiresAt = freshExpiresAt(120_000)
    saveLocationAuth(TEST_LOCATION, {
      authType: 'clerk',
      url: TEST_URL,
      accessToken: 'peer-at',
      refreshToken: 'peer-rt',
      accessTokenExpiresAt: peerExpiresAt,
    })

    const { getOAuthToken } = makeOAuthAccessTokenProvider(
      baseInit({ accessToken: 'stale-at', accessTokenExpiresAt: staleExpiresAt() }),
    )

    mockRefreshAccessToken.mockRejectedValue(new Error('should not be called'))

    const token = await getOAuthToken({ forceRefresh: false })

    expect(token).toBe('peer-at')
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('does not adopt disk token when on-disk expiry is stale', async () => {
    saveLocationAuth(TEST_LOCATION, {
      authType: 'clerk',
      url: TEST_URL,
      accessToken: 'disk-stale-at',
      refreshToken: 'disk-stale-rt',
      accessTokenExpiresAt: staleExpiresAt(),
    })

    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'refreshed-oauth-at',
      refreshToken: 'refreshed-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const { getOAuthToken } = makeOAuthAccessTokenProvider(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))

    const token = await getOAuthToken({ forceRefresh: false })

    expect(token).toBe('refreshed-oauth-at')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })

  it('returns null and clears access token when refreshAccessToken throws', async () => {
    mockRefreshAccessToken.mockRejectedValueOnce(new Error('invalid_grant'))

    const { getOAuthToken } = makeOAuthAccessTokenProvider(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))

    const token = await getOAuthToken({ forceRefresh: false })

    expect(token).toBeNull()
  })

  it('returns null when refreshToken is empty string', async () => {
    const { getOAuthToken } = makeOAuthAccessTokenProvider(
      baseInit({ refreshToken: '', accessTokenExpiresAt: staleExpiresAt() }),
    )

    const token = await getOAuthToken({ forceRefresh: false })

    expect(token).toBeNull()
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent in-process refresh calls (only one HTTP call)', async () => {
    let resolveRefresh!: (val: Awaited<ReturnType<typeof refreshAccessToken>>) => void
    const refreshPromise = new Promise<Awaited<ReturnType<typeof refreshAccessToken>>>((res) => {
      resolveRefresh = res
    })
    mockRefreshAccessToken.mockReturnValueOnce(refreshPromise)

    const { getOAuthToken } = makeOAuthAccessTokenProvider(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))

    const call1 = getOAuthToken({ forceRefresh: false })
    const call2 = getOAuthToken({ forceRefresh: false })

    resolveRefresh({
      accessToken: 'deduped-oauth-at',
      refreshToken: 'deduped-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const [t1, t2] = await Promise.all([call1, call2])
    expect(t1).toBe('deduped-oauth-at')
    expect(t2).toBe('deduped-oauth-at')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Tests: makeClerkAuthFetcher (outer Convex JWT layer)
// ---------------------------------------------------------------------------

describe('makeClerkAuthFetcher (outer Convex JWT exchange layer)', () => {
  beforeEach(() => {
    clearUserConfig()
    mockRefreshAccessToken.mockReset()
    mockExchangeOAuthTokenForConvexJwt.mockReset()
    // Default: exchange succeeds with a fresh Convex JWT
    mockExchangeOAuthTokenForConvexJwt.mockResolvedValue(defaultConvexJwtResult())
  })
  afterEach(() => clearUserConfig())

  it('returns cached convex JWT when still fresh and forceRefreshToken=false', async () => {
    const fetcher = makeClerkAuthFetcher(baseInit())

    // Prime the cache with a first call
    await fetcher({ forceRefreshToken: false })
    mockExchangeOAuthTokenForConvexJwt.mockClear()

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('convex-jwt-default')
    // Exchange should NOT be called again — served from cache
    expect(mockExchangeOAuthTokenForConvexJwt).not.toHaveBeenCalled()
  })

  it('exchanges OAuth for convex JWT on first call', async () => {
    mockExchangeOAuthTokenForConvexJwt.mockResolvedValueOnce(
      defaultConvexJwtResult({ jwt: 'cv-jwt-first', expiresAt: freshExpiresAt(60_000) }),
    )

    const fetcher = makeClerkAuthFetcher(baseInit())
    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('cv-jwt-first')
    expect(mockExchangeOAuthTokenForConvexJwt).toHaveBeenCalledOnce()
    expect(mockExchangeOAuthTokenForConvexJwt).toHaveBeenCalledWith(
      { kaiUrl: TEST_URL, oauthToken: 'initial-oauth-at' },
      undefined,
    )
  })

  it('re-exchanges when convex JWT is expired', async () => {
    // First exchange: gives a JWT that immediately expires
    mockExchangeOAuthTokenForConvexJwt
      .mockResolvedValueOnce(defaultConvexJwtResult({ jwt: 'cv-jwt-stale', expiresAt: staleExpiresAt() }))
      .mockResolvedValueOnce(defaultConvexJwtResult({ jwt: 'cv-jwt-fresh', expiresAt: freshExpiresAt(60_000) }))

    const fetcher = makeClerkAuthFetcher(baseInit())

    const t1 = await fetcher({ forceRefreshToken: false })
    expect(t1).toBe('cv-jwt-stale')

    // Second call: stale JWT → re-exchange
    const t2 = await fetcher({ forceRefreshToken: false })
    expect(t2).toBe('cv-jwt-fresh')
    expect(mockExchangeOAuthTokenForConvexJwt).toHaveBeenCalledTimes(2)
  })

  it('force-refreshes and re-exchanges when forceRefreshToken=true', async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'forced-oauth-at',
      refreshToken: 'forced-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })
    mockExchangeOAuthTokenForConvexJwt
      .mockResolvedValueOnce(defaultConvexJwtResult({ jwt: 'cv-jwt-initial' }))
      .mockResolvedValueOnce(defaultConvexJwtResult({ jwt: 'cv-jwt-forced' }))

    const fetcher = makeClerkAuthFetcher(baseInit())
    await fetcher({ forceRefreshToken: false })

    const token = await fetcher({ forceRefreshToken: true })
    expect(token).toBe('cv-jwt-forced')
  })

  it('force-refreshes OAuth and retries exchange on INVALID_OAUTH_TOKEN', async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'refreshed-oauth-at',
      refreshToken: 'refreshed-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })
    mockExchangeOAuthTokenForConvexJwt
      .mockRejectedValueOnce(new ConvexJwtExchangeError('INVALID_OAUTH_TOKEN', 'Token verification failed'))
      .mockResolvedValueOnce(defaultConvexJwtResult({ jwt: 'cv-jwt-after-retry' }))

    const fetcher = makeClerkAuthFetcher(baseInit())
    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('cv-jwt-after-retry')
    // First exchange: failed with INVALID_OAUTH_TOKEN
    // OAuth refresh was forced, then exchange retried
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
    expect(mockExchangeOAuthTokenForConvexJwt).toHaveBeenCalledTimes(2)
    // Second exchange call should use the refreshed OAuth token
    expect(mockExchangeOAuthTokenForConvexJwt).toHaveBeenNthCalledWith(
      2,
      { kaiUrl: TEST_URL, oauthToken: 'refreshed-oauth-at' },
      undefined,
    )
  })

  it('returns null on INVALID_OAUTH_TOKEN when OAuth force-refresh also fails', async () => {
    mockRefreshAccessToken.mockRejectedValueOnce(new Error('invalid_grant'))
    mockExchangeOAuthTokenForConvexJwt.mockRejectedValueOnce(
      new ConvexJwtExchangeError('INVALID_OAUTH_TOKEN', 'Token verification failed'),
    )

    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: freshExpiresAt() }))
    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
  })

  it('returns null on MISSING_SESSION (no retry)', async () => {
    mockExchangeOAuthTokenForConvexJwt.mockRejectedValueOnce(
      new ConvexJwtExchangeError('MISSING_SESSION', 'No session found'),
    )

    const fetcher = makeClerkAuthFetcher(baseInit())
    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
    // Should NOT retry OAuth refresh for non-INVALID_OAUTH_TOKEN codes
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
    expect(mockExchangeOAuthTokenForConvexJwt).toHaveBeenCalledOnce()
  })

  it('returns null on SESSION_NOT_FOUND (no retry)', async () => {
    mockExchangeOAuthTokenForConvexJwt.mockRejectedValueOnce(
      new ConvexJwtExchangeError('SESSION_NOT_FOUND', 'Session not found'),
    )

    const fetcher = makeClerkAuthFetcher(baseInit())
    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('returns null on TEMPLATE_NOT_FOUND (no retry)', async () => {
    mockExchangeOAuthTokenForConvexJwt.mockRejectedValueOnce(
      new ConvexJwtExchangeError('TEMPLATE_NOT_FOUND', 'Template not found'),
    )

    const fetcher = makeClerkAuthFetcher(baseInit())
    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('returns null on EXCHANGE_FAILED / network failure (no retry)', async () => {
    mockExchangeOAuthTokenForConvexJwt.mockRejectedValueOnce(new Error('fetch failed'))

    const fetcher = makeClerkAuthFetcher(baseInit())
    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('returns null when OAuth token cannot be obtained (null from inner layer)', async () => {
    // No refresh token → inner layer returns null immediately
    const fetcher = makeClerkAuthFetcher(baseInit({ refreshToken: '', accessTokenExpiresAt: staleExpiresAt() }))
    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
    expect(mockExchangeOAuthTokenForConvexJwt).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent in-process exchange calls', async () => {
    let resolveExchange!: (val: Awaited<ReturnType<typeof exchangeOAuthTokenForConvexJwt>>) => void
    const exchangePromise = new Promise<Awaited<ReturnType<typeof exchangeOAuthTokenForConvexJwt>>>((res) => {
      resolveExchange = res
    })
    mockExchangeOAuthTokenForConvexJwt.mockReturnValueOnce(exchangePromise)

    const fetcher = makeClerkAuthFetcher(baseInit())

    const call1 = fetcher({ forceRefreshToken: false })
    const call2 = fetcher({ forceRefreshToken: false })

    resolveExchange(defaultConvexJwtResult({ jwt: 'deduped-cv-jwt' }))

    const [t1, t2] = await Promise.all([call1, call2])
    expect(t1).toBe('deduped-cv-jwt')
    expect(t2).toBe('deduped-cv-jwt')
    expect(mockExchangeOAuthTokenForConvexJwt).toHaveBeenCalledOnce()
  })
})
