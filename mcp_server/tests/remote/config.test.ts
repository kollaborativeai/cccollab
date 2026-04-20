import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route the test through a private HOME so it doesn't trample the real
// ~/.cccollab. `os.homedir()` on Node honours `process.env.HOME` on
// Linux and macOS; on Windows it uses USERPROFILE, which we set too.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-config-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { loadRemoteConfig, saveRemoteConfig, clearRemoteConfig, summarizeRemoteConfig } =
  await import('../../src/remote/config.js')
const { CCCOLLAB_CONFIG_FILE } = await import('../../src/constants.js')

describe('remote config', () => {
  beforeEach(() => {
    clearRemoteConfig()
    delete process.env.CCCOLLAB_REMOTE_URL
    delete process.env.CCCOLLAB_HOSTED_URL
    delete process.env.CCCOLLAB_AUTH_TOKEN
    delete process.env.CCCOLLAB_AUTH_REFRESH_TOKEN
  })

  afterEach(() => {
    clearRemoteConfig()
  })

  afterAll(() => {
    rmSync(TMP_HOME, { recursive: true, force: true })
  })

  it('returns null when no file and no env', () => {
    expect(loadRemoteConfig()).toBeNull()
    expect(summarizeRemoteConfig()).toBeNull()
  })

  it('round-trips remoteUrl / accessToken / refreshToken through save + load', () => {
    saveRemoteConfig({
      remoteUrl: 'https://wonderful-narwhal-409.convex.cloud',
      accessToken: 'jwt-abc',
      refreshToken: 'refresh-xyz',
      userEmail: 'stefan@flatout.solutions',
      updatedAt: 1_700_000_000_000,
    })
    const cfg = loadRemoteConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.remoteUrl).toBe('https://wonderful-narwhal-409.convex.cloud')
    expect(cfg!.accessToken).toBe('jwt-abc')
    expect(cfg!.refreshToken).toBe('refresh-xyz')
    expect(cfg!.userEmail).toBe('stefan@flatout.solutions')
  })

  it('writes the config file with mode 0600', () => {
    saveRemoteConfig({
      remoteUrl: 'https://wonderful-narwhal-409.convex.cloud',
      accessToken: 'jwt-abc',
      refreshToken: 'refresh-xyz',
      updatedAt: Date.now(),
    })
    expect(existsSync(CCCOLLAB_CONFIG_FILE)).toBe(true)
    if (process.platform !== 'win32') {
      const mode = statSync(CCCOLLAB_CONFIG_FILE).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('env vars override the file', () => {
    saveRemoteConfig({
      remoteUrl: 'https://file.example.com',
      accessToken: 'file-token',
      refreshToken: 'file-refresh',
      updatedAt: 1,
    })
    process.env.CCCOLLAB_REMOTE_URL = 'https://env.example.com'
    process.env.CCCOLLAB_AUTH_TOKEN = 'env-token'
    process.env.CCCOLLAB_AUTH_REFRESH_TOKEN = 'env-refresh'
    const cfg = loadRemoteConfig()
    expect(cfg!.remoteUrl).toBe('https://env.example.com')
    expect(cfg!.accessToken).toBe('env-token')
    expect(cfg!.refreshToken).toBe('env-refresh')
  })

  it('returns empty-token config when URL is set but no tokens exist', () => {
    process.env.CCCOLLAB_REMOTE_URL = 'https://env.example.com'
    const cfg = loadRemoteConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.remoteUrl).toBe('https://env.example.com')
    expect(cfg!.accessToken).toBe('')
    expect(cfg!.refreshToken).toBe('')
  })

  it('falls back to the legacy CCCOLLAB_HOSTED_URL env var when CCCOLLAB_REMOTE_URL is unset', () => {
    process.env.CCCOLLAB_HOSTED_URL = 'https://legacy.example.com'
    process.env.CCCOLLAB_AUTH_TOKEN = 'env-token'
    process.env.CCCOLLAB_AUTH_REFRESH_TOKEN = 'env-refresh'
    const cfg = loadRemoteConfig()
    expect(cfg!.remoteUrl).toBe('https://legacy.example.com')
  })

  it('CCCOLLAB_REMOTE_URL wins over CCCOLLAB_HOSTED_URL when both are set', () => {
    process.env.CCCOLLAB_REMOTE_URL = 'https://new.example.com'
    process.env.CCCOLLAB_HOSTED_URL = 'https://legacy.example.com'
    const cfg = loadRemoteConfig()
    expect(cfg!.remoteUrl).toBe('https://new.example.com')
  })

  it('reads a legacy config file with "hostedUrl" field for backwards compatibility', () => {
    // Simulate a config file written by a prior version of the CLI.
    writeFileSync(
      CCCOLLAB_CONFIG_FILE,
      JSON.stringify({
        hostedUrl: 'https://legacy.example.com',
        accessToken: 'old-token',
        refreshToken: 'old-refresh',
        userEmail: 'stefan@flatout.solutions',
        updatedAt: 1,
      }) + '\n',
    )
    chmodSync(CCCOLLAB_CONFIG_FILE, 0o600)
    const cfg = loadRemoteConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.remoteUrl).toBe('https://legacy.example.com')
    expect(cfg!.accessToken).toBe('old-token')
    expect(cfg!.userEmail).toBe('stefan@flatout.solutions')
  })

  it('summary hides tokens and reports source', () => {
    saveRemoteConfig({
      remoteUrl: 'https://file.example.com',
      accessToken: 'a',
      refreshToken: 'b',
      userEmail: 'stefan@flatout.solutions',
      updatedAt: 1,
    })
    const sumFile = summarizeRemoteConfig()
    expect(sumFile!.hasAccessToken).toBe(true)
    expect(sumFile!.hasRefreshToken).toBe(true)
    expect(sumFile!.source).toBe('file')
    expect(JSON.stringify(sumFile)).not.toMatch(/"a"|"b"/)

    process.env.CCCOLLAB_REMOTE_URL = 'https://env.example.com'
    const sumMixed = summarizeRemoteConfig()
    expect(sumMixed!.source).toBe('mixed')
  })

  it('tolerates a corrupted config file by returning null', () => {
    writeFileSync(CCCOLLAB_CONFIG_FILE, '{ not valid json')
    chmodSync(CCCOLLAB_CONFIG_FILE, 0o600)
    expect(loadRemoteConfig()).toBeNull()
  })
})
