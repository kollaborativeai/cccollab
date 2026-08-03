import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Private HOME so the test never touches the real `~/.cccollab`.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-inproc-lock-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { saveLocationAuth, withConfigLock, loadPersistedLocationAuth, clearUserConfig } =
  await import('../../src/config/save.js')
const { CCCOLLAB_CONFIG_FILE } = await import('../../src/constants.js')

const AUTH = {
  authType: 'clerk',
  url: 'https://a.convex.cloud',
  accessToken: 'a',
  refreshToken: 'r',
  idToken: 'id',
  accessTokenExpiresAt: 1_700_000_000_000,
} as const

describe('in-process config lock', () => {
  beforeEach(() => {
    clearUserConfig()
  })
  afterEach(() => {
    clearUserConfig()
    try {
      rmSync(`${CCCOLLAB_CONFIG_FILE}.lock`, { force: true })
    } catch {
      /* ignore */
    }
  })
  afterAll(() => {
    rmSync(TMP_HOME, { recursive: true, force: true })
  })

  it('does not deadlock when two same-process withConfigLock callers overlap', async () => {
    // This is the two-remote-locations startup deadlock: refresh A takes
    // the lock and yields on its network await; refresh B, in the SAME
    // process, then tries to acquire and (pre-fix) sync-spins the event
    // loop so A can never resume — guaranteed 5s lock timeout.
    const order: string[] = []

    const a = withConfigLock(async (persist) => {
      order.push('a-start')
      // Simulate the awaited network refresh call.
      await new Promise((resolve) => setTimeout(resolve, 100))
      persist('locA', { ...AUTH, idToken: 'id-a' })
      order.push('a-end')
    })

    const b = withConfigLock(async (persist) => {
      order.push('b-start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      persist('locB', { ...AUTH, idToken: 'id-b' })
      order.push('b-end')
    })

    await expect(Promise.all([a, b])).resolves.toBeDefined()

    // Strict serialisation: B must not enter while A holds the lock.
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
    expect(loadPersistedLocationAuth('locA')?.idToken).toBe('id-a')
    expect(loadPersistedLocationAuth('locB')?.idToken).toBe('id-b')
    expect(existsSync(`${CCCOLLAB_CONFIG_FILE}.lock`)).toBe(false)
  })

  it('saveLocationAuth queues behind an in-flight withConfigLock instead of deadlocking', async () => {
    const held = withConfigLock(async (persist) => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      persist('locA', { ...AUTH, idToken: 'id-a' })
    })

    // Same process, so this must queue asynchronously rather than spin
    // on a lock file whose PID is our own live process.
    const saved = saveLocationAuth('locB', { ...AUTH, idToken: 'id-b' })

    await expect(Promise.all([held, saved])).resolves.toBeDefined()
    expect(loadPersistedLocationAuth('locA')?.idToken).toBe('id-a')
    expect(loadPersistedLocationAuth('locB')?.idToken).toBe('id-b')
  })
})
