import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route the test through a private HOME so it doesn't trample the
// real `~/.cccollab`. `os.homedir()` on Node honours `process.env.HOME`
// on Linux / macOS; on Windows it uses USERPROFILE, which we set too.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-save-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { saveLocationAuth, clearUserConfig } = await import('../../src/config/save.js')
const { CCCOLLAB_CONFIG_FILE } = await import('../../src/constants.js')

describe('saveLocationAuth', () => {
  beforeEach(() => {
    clearUserConfig()
  })
  afterEach(() => {
    clearUserConfig()
  })
  afterAll(() => {
    rmSync(TMP_HOME, { recursive: true, force: true })
  })

  it('writes auth fields under the named location in the user-level file', () => {
    saveLocationAuth('flatout', {
      url: 'https://wonderful-narwhal-409.convex.cloud',
      accessToken: 'jwt-abc',
      refreshToken: 'refresh-xyz',
      userEmail: 'stefan@flatout.solutions',
      userId: 'abc123',
      updatedAt: 1_700_000_000_000,
    })
    expect(existsSync(CCCOLLAB_CONFIG_FILE)).toBe(true)
    const content = JSON.parse(readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8'))
    expect(content.locations.flatout.accessToken).toBe('jwt-abc')
    expect(content.locations.flatout.refreshToken).toBe('refresh-xyz')
    expect(content.locations.flatout.userEmail).toBe('stefan@flatout.solutions')
    expect(content.locations.flatout.url).toBe('https://wonderful-narwhal-409.convex.cloud')
    expect(content.locations.flatout.updatedAt).toBe(1_700_000_000_000)
  })

  it('writes the file with mode 0600', () => {
    saveLocationAuth('flatout', {
      url: 'https://a.convex.cloud',
      accessToken: 'a',
      refreshToken: 'b',
    })
    if (process.platform !== 'win32') {
      const mode = statSync(CCCOLLAB_CONFIG_FILE).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('preserves other locations and top-level fields when updating one location', () => {
    // Pre-populate the user-level file with two locations and a
    // top-level `name` to verify they survive the round-trip.
    writeFileSync(
      CCCOLLAB_CONFIG_FILE,
      JSON.stringify(
        {
          name: 'cccollab maintainer',
          locations: {
            flatout: {
              url: 'https://a.convex.cloud',
              accessToken: 'old-token',
              refreshToken: 'old-refresh',
              userEmail: 'user@example.com',
            },
            other: {
              url: 'https://b.convex.cloud',
              accessToken: 'other-token',
              refreshToken: 'other-refresh',
            },
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    saveLocationAuth('flatout', {
      accessToken: 'new-token',
      refreshToken: 'new-refresh',
    })
    const content = JSON.parse(readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8'))
    expect(content.name).toBe('cccollab maintainer')
    expect(content.locations.flatout.accessToken).toBe('new-token')
    expect(content.locations.flatout.refreshToken).toBe('new-refresh')
    // Fields not provided in the update survive.
    expect(content.locations.flatout.url).toBe('https://a.convex.cloud')
    expect(content.locations.flatout.userEmail).toBe('user@example.com')
    // Other locations untouched.
    expect(content.locations.other.accessToken).toBe('other-token')
  })

  it('creates the file when it does not yet exist', () => {
    expect(existsSync(CCCOLLAB_CONFIG_FILE)).toBe(false)
    saveLocationAuth('flatout', {
      url: 'https://a.convex.cloud',
      accessToken: 'a',
      refreshToken: 'b',
    })
    expect(existsSync(CCCOLLAB_CONFIG_FILE)).toBe(true)
  })

  it('preserves a corrupt prior config as a timestamped backup before overwriting', async () => {
    // Write a file that passes JSON.parse but fails the zod schema
    // (a zod failure should also trigger the backup path).
    const dir = (await import('node:path')).dirname(CCCOLLAB_CONFIG_FILE)
    const { readdirSync } = await import('node:fs')
    writeFileSync(CCCOLLAB_CONFIG_FILE, '{this is not valid json', { mode: 0o600 })

    saveLocationAuth('flatout', {
      url: 'https://a.convex.cloud',
      accessToken: 'new-token',
      refreshToken: 'new-refresh',
    })

    // New file is healthy.
    const content = JSON.parse(readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8'))
    expect(content.locations.flatout.accessToken).toBe('new-token')

    // A backup file exists alongside.
    const entries = readdirSync(dir)
    const backups = entries.filter((e) => e.startsWith('config.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
  })
})
