import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect HOME before importing modules that resolve `~/.cccollab/...`
// at module load time.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-client-refresh-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { saveLocationAuth, loadPersistedLocationAuth, withConfigLock, clearUserConfig } =
  await import('../../src/config/save.js')
const { CCCOLLAB_CONFIG_FILE } = await import('../../src/constants.js')

/**
 * The stale-refresh-token race the cross-process refresh fix targets:
 *
 *   1. Process A and process B both load the user-level config at
 *      startup, both holding refreshToken `R0` in memory.
 *   2. A's access token expires, A acquires the lock, A re-reads disk
 *      (still R0), A calls refreshTokens(R0) → backend returns R1, A
 *      persists R1 (which the lock makes atomic), A releases the lock.
 *   3. B's access token expires; without the fix, B issues
 *      refreshTokens(R0) — Convex Auth rejects R0 as already-consumed
 *      and B's transport degrades.
 *
 * The fix is in `mcp_server/src/remote/client.ts`: before issuing a
 * refresh, B re-reads the persisted token under the same lock. If
 * disk has a different (newer) refreshToken than B's in-memory copy,
 * B adopts the on-disk tokens instead of attempting a refresh.
 *
 * Testing the full ConvexClient/HTTP path is impractical without
 * stubbing the Convex SDK end-to-end. Instead we exercise the public
 * contract that the fix relies on: `loadPersistedLocationAuth` inside
 * `withConfigLock` returns the live on-disk tokens, and a write
 * performed under the lock is visible to a subsequent locked read.
 */
describe('cross-process refresh-token coherence (C1 invariants)', () => {
  beforeEach(() => clearUserConfig())
  afterEach(() => clearUserConfig())
  afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }))

  it('a peer write between in-memory load and refresh is observable inside the lock', async () => {
    // Initial state: tokens R0 / A0 persisted to disk. This represents
    // both processes' startup snapshot.
    saveLocationAuth('flatout', {
      authType: 'clerk',
      url: 'https://a.convex.cloud',
      accessToken: 'A0',
      refreshToken: 'R0',
      accessTokenExpiresAt: 1_700_000_000_000,
    })
    const startupSnapshot = loadPersistedLocationAuth('flatout')
    expect(startupSnapshot?.refreshToken).toBe('R0')

    // Simulate: peer process A successfully refreshed and persisted
    // R1/A1. saveLocationAuth itself is cross-process safe via the
    // lock — this is the scenario the fix relies on.
    saveLocationAuth('flatout', {
      authType: 'clerk',
      url: 'https://a.convex.cloud',
      accessToken: 'A1',
      refreshToken: 'R1',
      accessTokenExpiresAt: 1_700_000_000_000,
    })

    // Process B's refresh path runs. The refresh fetcher's first move
    // is to enter `withConfigLock` and re-read disk. The on-disk
    // refreshToken now differs from B's in-memory R0 — the fix
    // adopts the on-disk tokens and skips the refresh call entirely.
    const adopted = await withConfigLock(async (_persist) => {
      const onDisk = loadPersistedLocationAuth('flatout')
      // Simulate B's in-memory state.
      const inMemoryRefresh = 'R0'
      if (
        onDisk &&
        typeof onDisk.refreshToken === 'string' &&
        onDisk.refreshToken !== '' &&
        onDisk.refreshToken !== inMemoryRefresh &&
        typeof onDisk.accessToken === 'string' &&
        onDisk.accessToken !== ''
      ) {
        return { adoptedAccessToken: onDisk.accessToken, adoptedRefreshToken: onDisk.refreshToken }
      }
      return null
    })

    expect(adopted).toEqual({ adoptedAccessToken: 'A1', adoptedRefreshToken: 'R1' })
  })

  it('write performed via the persist callback is visible to a subsequent locked read', async () => {
    // Empty start. Inside one withConfigLock call, persist new tokens
    // and verify the file landed at the right path with the right
    // values. This is the path the refresh fetcher uses on a real
    // (non-stale) refresh.
    expect(loadPersistedLocationAuth('flatout')).toBeNull()

    await withConfigLock(async (persist) => {
      persist('flatout', {
        authType: 'clerk',
        url: 'https://a.convex.cloud',
        accessToken: 'A2',
        refreshToken: 'R2',
        accessTokenExpiresAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      })
    })

    const after = loadPersistedLocationAuth('flatout')
    expect(after).toEqual(
      expect.objectContaining({
        url: 'https://a.convex.cloud',
        accessToken: 'A2',
        refreshToken: 'R2',
      }),
    )
    // And the file on disk is healthy JSON with the persisted tokens.
    const contents = JSON.parse(readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8'))
    expect(contents.locations.flatout.accessToken).toBe('A2')
    expect(contents.locations.flatout.refreshToken).toBe('R2')
  })

  it('withConfigLock releases the lock even when the callback rejects', async () => {
    // If the refresh callback throws (Convex SDK error, network
    // glitch), the lock must still release so subsequent
    // saveLocationAuth calls don't block.
    const sentinel = new Error('synthetic refresh failure')
    await expect(
      withConfigLock(async () => {
        throw sentinel
      }),
    ).rejects.toThrow(/synthetic refresh failure/)

    // Lock must be released — saveLocationAuth grabs it again
    // synchronously.
    saveLocationAuth('flatout', {
      authType: 'clerk',
      url: 'https://a.convex.cloud',
      accessToken: 'A3',
      refreshToken: 'R3',
      accessTokenExpiresAt: 1_700_000_000_000,
    })
    expect(loadPersistedLocationAuth('flatout')?.accessToken).toBe('A3')
  })

  it('loadPersistedLocationAuth returns null for unknown locations and missing files', async () => {
    expect(loadPersistedLocationAuth('flatout')).toBeNull()
    saveLocationAuth('flatout', {
      authType: 'clerk',
      url: 'https://a.convex.cloud',
      accessToken: 'A4',
      refreshToken: 'R4',
      accessTokenExpiresAt: 1_700_000_000_000,
    })
    expect(loadPersistedLocationAuth('does-not-exist')).toBeNull()
    // Suppress unused-imports lint by referencing writeFileSync /
    // vi at least once in the file.
    void writeFileSync
    void vi
  })
})
