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
// refreshAccessToken with a vi.fn() tests configure per-case.
vi.mock('../../src/remote/auth-clerk.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/remote/auth-clerk.js')>()
  return {
    ...actual,
    refreshAccessToken: vi.fn(),
  }
})

const { makeClerkAuthFetcher, CLERK_FRESHNESS_MARGIN_MS } = await import('../../src/remote/client.js')
const { refreshAccessToken } = await import('../../src/remote/auth-clerk.js')
const mockRefreshAccessToken = vi.mocked(refreshAccessToken)

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
    idToken: 'initial-id-token',
    refreshToken: 'initial-rt',
    accessTokenExpiresAt: freshExpiresAt(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: makeClerkAuthFetcher — returns the OIDC ID token Convex verifies,
// refreshing the OAuth tokens (and rotating the ID token) when stale.
// ---------------------------------------------------------------------------

describe('makeClerkAuthFetcher', () => {
  beforeEach(() => {
    clearUserConfig()
    mockRefreshAccessToken.mockReset()
  })
  afterEach(() => clearUserConfig())
  afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }))

  it('returns the cached ID token when still fresh and forceRefreshToken is false', async () => {
    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: freshExpiresAt(60_000) }))

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('initial-id-token')
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('returns the cached ID token when expiry is exactly at the freshness margin boundary + 1ms', async () => {
    // Freeze the clock. The fetcher decides freshness with its own Date.now(),
    // so on a real clock this case only holds while the millisecond that the
    // test read has not ticked over -- a 1ms budget that a loaded CI runner
    // loses. Freezing pins the gap at exactly the margin + 1ms the name claims.
    const frozenNow = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenNow)

    try {
      const fetcher = makeClerkAuthFetcher(
        baseInit({ accessTokenExpiresAt: frozenNow + CLERK_FRESHNESS_MARGIN_MS + 1 }),
      )

      const token = await fetcher({ forceRefreshToken: false })

      expect(token).toBe('initial-id-token')
      expect(mockRefreshAccessToken).not.toHaveBeenCalled()
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('refreshes and returns the new ID token when the token is expired', async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-oauth-at',
      refreshToken: 'new-rt',
      idToken: 'new-id-token',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('new-id-token')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
    expect(mockRefreshAccessToken).toHaveBeenCalledWith({
      issuer: TEST_ISSUER,
      clientId: TEST_CLIENT_ID,
      refreshToken: 'initial-rt',
      fallbackIdToken: 'initial-id-token',
    })
  })

  it('persists new tokens (including the ID token) to disk after a successful refresh', async () => {
    const newExpiresAt = freshExpiresAt(3600_000)
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-oauth-at',
      refreshToken: 'new-rt',
      idToken: 'new-id-token',
      accessTokenExpiresAt: newExpiresAt,
    })

    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))
    await fetcher({ forceRefreshToken: false })

    const { loadPersistedLocationAuth } = await import('../../src/config/save.js')
    const onDisk = loadPersistedLocationAuth(TEST_LOCATION)
    expect(onDisk?.accessToken).toBe('new-oauth-at')
    expect(onDisk?.refreshToken).toBe('new-rt')
    expect(onDisk?.idToken).toBe('new-id-token')
    expect(onDisk?.accessTokenExpiresAt).toBe(newExpiresAt)
    expect(onDisk?.authType).toBe('clerk')
  })

  it('force-refreshes when forceRefreshToken=true even if still fresh', async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'forced-new-oauth-at',
      refreshToken: 'forced-new-rt',
      idToken: 'forced-new-id-token',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: freshExpiresAt(60_000) }))

    const token = await fetcher({ forceRefreshToken: true })

    expect(token).toBe('forced-new-id-token')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })

  it('adopts a peer-process refresh from disk instead of calling refreshAccessToken', async () => {
    const peerExpiresAt = freshExpiresAt(120_000)
    saveLocationAuth(TEST_LOCATION, {
      authType: 'clerk',
      url: TEST_URL,
      accessToken: 'peer-at',
      refreshToken: 'peer-rt',
      idToken: 'peer-id-token',
      accessTokenExpiresAt: peerExpiresAt,
    })

    const fetcher = makeClerkAuthFetcher(baseInit({ idToken: 'stale-id', accessTokenExpiresAt: staleExpiresAt() }))

    mockRefreshAccessToken.mockRejectedValue(new Error('should not be called'))

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('peer-id-token')
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('does not adopt the disk token when its expiry is stale', async () => {
    saveLocationAuth(TEST_LOCATION, {
      authType: 'clerk',
      url: TEST_URL,
      accessToken: 'disk-stale-at',
      refreshToken: 'disk-stale-rt',
      idToken: 'disk-stale-id',
      accessTokenExpiresAt: staleExpiresAt(),
    })

    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'refreshed-oauth-at',
      refreshToken: 'refreshed-rt',
      idToken: 'refreshed-id-token',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('refreshed-id-token')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })

  it('returns null and clears the ID token when refreshAccessToken throws', async () => {
    mockRefreshAccessToken.mockRejectedValueOnce(new Error('invalid_grant'))

    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
  })

  it('returns null when the refresh token is an empty string', async () => {
    const fetcher = makeClerkAuthFetcher(baseInit({ refreshToken: '', accessTokenExpiresAt: staleExpiresAt() }))

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent in-process refresh calls (only one HTTP call)', async () => {
    let resolveRefresh!: (val: Awaited<ReturnType<typeof refreshAccessToken>>) => void
    const refreshPromise = new Promise<Awaited<ReturnType<typeof refreshAccessToken>>>((res) => {
      resolveRefresh = res
    })
    mockRefreshAccessToken.mockReturnValueOnce(refreshPromise)

    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: staleExpiresAt() }))

    const call1 = fetcher({ forceRefreshToken: false })
    const call2 = fetcher({ forceRefreshToken: false })

    resolveRefresh({
      accessToken: 'deduped-oauth-at',
      refreshToken: 'deduped-rt',
      idToken: 'deduped-id-token',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const [t1, t2] = await Promise.all([call1, call2])
    expect(t1).toBe('deduped-id-token')
    expect(t2).toBe('deduped-id-token')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })
})
