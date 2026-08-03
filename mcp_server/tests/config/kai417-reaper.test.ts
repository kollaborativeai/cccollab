/**
 * KAI-417 bug 3: the stale-lock reaper treated an unreadable / empty PID
 * body as PROOF OF DEATH (parseInt('') -> NaN -> isPidDead returns true),
 * so it would unlink a lock it had no evidence was abandoned — including a
 * live holder's freshly-written one. Two processes then enter the critical
 * section and both burn the same single-use Clerk refresh token.
 *
 * Fail-closed: a reaper acts only on POSITIVE proof of death.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_HOME = mkdtempSync(join(tmpdir(), 'kai417-reaper-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { saveLocationAuth } = await import('../../src/config/save.js')
const { CCCOLLAB_CONFIG_FILE, CCCOLLAB_HOME } = await import('../../src/constants.js')

const LOCK = `${CCCOLLAB_CONFIG_FILE}.lock`

beforeEach(() => {
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  if (existsSync(LOCK)) rmSync(LOCK)
})
afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }))

/** Plant a lock whose body is `body`, aged well past STALE_LOCK_MS. */
function plantAncientLock(body: string): void {
  writeFileSync(LOCK, body)
  const ancient = new Date(Date.now() - 120_000)
  utimesSync(LOCK, ancient, ancient)
}

const AUTH = {
  authType: 'clerk' as const,
  url: 'https://x.convex.cloud',
  accessToken: 'at',
  refreshToken: 'rt',
  idToken: 'it',
  accessTokenExpiresAt: Date.now() + 3_600_000,
}

describe('stale-lock reaper acts only on positive proof of death', () => {
  it('does NOT reap a 0-byte lock body (torn write — death is unproven)', async () => {
    plantAncientLock('')
    // Fail-closed: no proof the holder is dead => refuse to unlink, block,
    // and fail LOUDLY at the timeout (the error tells the user to delete it).
    await expect(saveLocationAuth('remote', AUTH)).rejects.toThrow(/timed out after \d+ms waiting for/)
    expect(existsSync(LOCK)).toBe(true) // we did not steal it
  }, 20000)

  it('does NOT reap a lock whose body is unparseable garbage', async () => {
    plantAncientLock('not-a-pid\n')
    await expect(saveLocationAuth('remote', AUTH)).rejects.toThrow(/timed out after \d+ms waiting for/)
    expect(existsSync(LOCK)).toBe(true)
  }, 20000)

  it('still reaps a stale lock whose holder PID is provably dead', async () => {
    // 2^22 is above Linux's default pid_max (4194304 is the ceiling; this
    // pid is not live in the test env) — process.kill(pid, 0) => ESRCH.
    plantAncientLock('4194303')
    await expect(saveLocationAuth('remote', AUTH)).resolves.toBeUndefined()
  }, 20000)
})
