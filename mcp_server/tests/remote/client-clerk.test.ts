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
// refreshAccessToken with a vi.fn() that tests can configure per-case.
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
    accessToken: 'initial-at',
    refreshToken: 'initial-rt',
    accessTokenExpiresAt: freshExpiresAt(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clerk setAuth callback (makeClerkAuthFetcher)', () => {
  beforeEach(() => {
    clearUserConfig()
    mockRefreshAccessToken.mockReset()
  })
  afterEach(() => clearUserConfig())
  afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }))

  it('returns cached access token when still fresh and forceRefreshToken is false', async () => {
    const fetcher = makeClerkAuthFetcher(baseInit({ accessTokenExpiresAt: freshExpiresAt(60_000) }))

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('initial-at')
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('returns cached token when expiry is exactly at the freshness margin boundary + 1ms', async () => {
    const fetcher = makeClerkAuthFetcher(
      baseInit({ accessTokenExpiresAt: Date.now() + CLERK_FRESHNESS_MARGIN_MS + 1 }),
    )

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('initial-at')
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('refreshes when token is expired (expiresAt in the past)', async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const fetcher = makeClerkAuthFetcher(
      baseInit({ accessTokenExpiresAt: staleExpiresAt() }),
    )

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('new-at')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
    expect(mockRefreshAccessToken).toHaveBeenCalledWith({
      issuer: TEST_ISSUER,
      clientId: TEST_CLIENT_ID,
      refreshToken: 'initial-rt',
    })
  })

  it('persists new tokens to disk after a successful refresh', async () => {
    const newExpiresAt = freshExpiresAt(3600_000)
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      accessTokenExpiresAt: newExpiresAt,
    })

    const fetcher = makeClerkAuthFetcher(
      baseInit({ accessTokenExpiresAt: staleExpiresAt() }),
    )
    await fetcher({ forceRefreshToken: false })

    // Import save after the write so we read the latest state
    const { loadPersistedLocationAuth } = await import('../../src/config/save.js')
    const onDisk = loadPersistedLocationAuth(TEST_LOCATION)
    expect(onDisk?.accessToken).toBe('new-at')
    expect(onDisk?.refreshToken).toBe('new-rt')
    expect(onDisk?.accessTokenExpiresAt).toBe(newExpiresAt)
    expect(onDisk?.authType).toBe('clerk')
  })

  it('refreshes on forceRefreshToken even when cached token is still fresh', async () => {
    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'forced-new-at',
      refreshToken: 'forced-new-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const fetcher = makeClerkAuthFetcher(
      baseInit({ accessTokenExpiresAt: freshExpiresAt(60_000) }),
    )

    const token = await fetcher({ forceRefreshToken: true })

    expect(token).toBe('forced-new-at')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })

  it('adopts peer-process refresh from disk instead of calling refreshAccessToken', async () => {
    // A sibling process wrote fresher tokens to disk.
    const peerExpiresAt = freshExpiresAt(120_000)
    saveLocationAuth(TEST_LOCATION, {
      authType: 'clerk',
      url: TEST_URL,
      accessToken: 'peer-at',
      refreshToken: 'peer-rt',
      accessTokenExpiresAt: peerExpiresAt,
    })

    // Our in-process state has a stale access token with an older expiry.
    const fetcher = makeClerkAuthFetcher(
      baseInit({ accessToken: 'stale-at', accessTokenExpiresAt: staleExpiresAt() }),
    )

    // refreshAccessToken should NOT be called — we should adopt disk.
    mockRefreshAccessToken.mockRejectedValue(new Error('should not be called'))

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('peer-at')
    expect(mockRefreshAccessToken).not.toHaveBeenCalled()
  })

  it('does not adopt disk token when on-disk expiry is stale', async () => {
    // Disk has a token but it is also expired — we should issue a refresh,
    // not short-circuit.
    saveLocationAuth(TEST_LOCATION, {
      authType: 'clerk',
      url: TEST_URL,
      accessToken: 'disk-stale-at',
      refreshToken: 'disk-stale-rt',
      accessTokenExpiresAt: staleExpiresAt(),
    })

    mockRefreshAccessToken.mockResolvedValueOnce({
      accessToken: 'refreshed-at',
      refreshToken: 'refreshed-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const fetcher = makeClerkAuthFetcher(
      baseInit({ accessTokenExpiresAt: staleExpiresAt() }),
    )

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBe('refreshed-at')
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })

  it('returns null and clears access token when refreshAccessToken throws', async () => {
    mockRefreshAccessToken.mockRejectedValueOnce(new Error('invalid_grant'))

    const fetcher = makeClerkAuthFetcher(
      baseInit({ accessTokenExpiresAt: staleExpiresAt() }),
    )

    const token = await fetcher({ forceRefreshToken: false })

    expect(token).toBeNull()
  })

  it('returns null when refreshToken is empty string', async () => {
    const fetcher = makeClerkAuthFetcher(
      baseInit({ refreshToken: '', accessTokenExpiresAt: staleExpiresAt() }),
    )

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

    const fetcher = makeClerkAuthFetcher(
      baseInit({ accessTokenExpiresAt: staleExpiresAt() }),
    )

    // Fire two concurrent calls.
    const call1 = fetcher({ forceRefreshToken: false })
    const call2 = fetcher({ forceRefreshToken: false })

    // Resolve the single mock refresh.
    resolveRefresh({
      accessToken: 'deduped-at',
      refreshToken: 'deduped-rt',
      accessTokenExpiresAt: freshExpiresAt(3600_000),
    })

    const [t1, t2] = await Promise.all([call1, call2])
    expect(t1).toBe('deduped-at')
    expect(t2).toBe('deduped-at')
    // Mock must have been called exactly once despite two concurrent callers.
    expect(mockRefreshAccessToken).toHaveBeenCalledOnce()
  })
})
