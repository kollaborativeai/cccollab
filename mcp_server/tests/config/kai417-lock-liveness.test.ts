/**
 * cc#33 / KAI-417 — orchestrator-confirmed regressions on the lock:
 *  1. LOCK_TIMEOUT must exceed CLERK_FETCH_TIMEOUT (timeout inversion).
 *  2. A permanently unreadable lock path must time out, not CPU-spin forever.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_HOME = mkdtempSync(join(tmpdir(), 'kai417-lock-live-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { saveLocationAuth, LOCK_TIMEOUT_MS } = await import('../../src/config/save.js')
const { CLERK_FETCH_TIMEOUT_MS } = await import('../../src/remote/auth-clerk.js')
const { CCCOLLAB_CONFIG_FILE, CCCOLLAB_HOME } = await import('../../src/constants.js')

const LOCK = `${CCCOLLAB_CONFIG_FILE}.lock`

beforeEach(() => {
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  if (existsSync(LOCK)) rmSync(LOCK, { recursive: true, force: true })
})
afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }))

const AUTH = {
  authType: 'clerk' as const,
  url: 'https://x.convex.cloud',
  accessToken: 'at',
  refreshToken: 'rt',
  idToken: 'it',
  accessTokenExpiresAt: Date.now() + 3_600_000,
}

describe('KAI-417 lock liveness (cc#33 orchestrator-confirmed)', () => {
  it('LOCK_TIMEOUT_MS strictly exceeds CLERK_FETCH_TIMEOUT_MS (no timeout inversion)', () => {
    // A refresh runs INSIDE the lock and may take the full fetch budget.
    // Peers waiting on the lock must outlast that, or a healthy 7s refresh
    // times every other process out and the error tells them to delete a
    // live lock — the concurrent double-refresh this module exists to stop.
    expect(LOCK_TIMEOUT_MS).toBeGreaterThan(CLERK_FETCH_TIMEOUT_MS)
    expect(LOCK_TIMEOUT_MS).toBe(CLERK_FETCH_TIMEOUT_MS + 5_000)
  })

  it('a permanently unreadable lock path times out instead of spinning forever', async () => {
    // Plant LOCK as a DIRECTORY older than STALE_LOCK_MS: wx → EEXIST,
    // stat succeeds, age is stale, readFileSync throws EISDIR. Before the
    // fix, bare `continue` skipped deadline + sleep → 100% CPU forever.
    mkdirSync(LOCK)
    const ancient = new Date(Date.now() - 120_000)
    utimesSync(LOCK, ancient, ancient)

    const start = Date.now()
    let message = ''
    await expect(
      saveLocationAuth('remote', AUTH).catch((err: unknown) => {
        message = err instanceof Error ? err.message : String(err)
        throw err
      }),
    ).rejects.toThrow(/timed out after \d+ms waiting for/)
    const elapsed = Date.now() - start
    // Bounded by LOCK_TIMEOUT_MS (± jitter), not unbounded.
    expect(elapsed).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 2_000)
    expect(elapsed).toBeLessThan(LOCK_TIMEOUT_MS + 5_000)
    // Error must not lead with "delete the lock file" as the first advice.
    expect(message).toMatch(/may still be refreshing|single-use Clerk refresh token/)
  }, 40_000)

  it('timeout error softens the delete-the-lock advice', async () => {
    // Live holder: our own PID + ancient mtime → not reaped → times out.
    writeFileSync(LOCK, String(process.pid))
    const ancient = new Date(Date.now() - 120_000)
    utimesSync(LOCK, ancient, ancient)

    await expect(saveLocationAuth('remote', AUTH)).rejects.toThrow(
      /single-use Clerk refresh token|may still be refreshing/,
    )
  }, 40_000)
})
