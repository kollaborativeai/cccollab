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

const { loadHostedConfig, saveHostedConfig, clearHostedConfig, summarizeHostedConfig } =
  await import('../../src/remote/config.js')
const { CCCOLLAB_CONFIG_FILE } = await import('../../src/constants.js')

describe('hosted config', () => {
  beforeEach(() => {
    clearHostedConfig()
    delete process.env.CCCOLLAB_HOSTED_URL
    delete process.env.CCCOLLAB_AUTH_TOKEN
    delete process.env.CCCOLLAB_AUTH_REFRESH_TOKEN
  })

  afterEach(() => {
    clearHostedConfig()
  })

  afterAll(() => {
    rmSync(TMP_HOME, { recursive: true, force: true })
  })

  it('returns null when no file and no env', () => {
    expect(loadHostedConfig()).toBeNull()
    expect(summarizeHostedConfig()).toBeNull()
  })

  it('round-trips hostedUrl / accessToken / refreshToken through save + load', () => {
    saveHostedConfig({
      hostedUrl: 'https://wonderful-narwhal-409.convex.cloud',
      accessToken: 'jwt-abc',
      refreshToken: 'refresh-xyz',
      userEmail: 'stefan@flatout.solutions',
      updatedAt: 1_700_000_000_000,
    })
    const cfg = loadHostedConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.hostedUrl).toBe('https://wonderful-narwhal-409.convex.cloud')
    expect(cfg!.accessToken).toBe('jwt-abc')
    expect(cfg!.refreshToken).toBe('refresh-xyz')
    expect(cfg!.userEmail).toBe('stefan@flatout.solutions')
  })

  it('writes the config file with mode 0600', () => {
    saveHostedConfig({
      hostedUrl: 'https://wonderful-narwhal-409.convex.cloud',
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
    saveHostedConfig({
      hostedUrl: 'https://file.example.com',
      accessToken: 'file-token',
      refreshToken: 'file-refresh',
      updatedAt: 1,
    })
    process.env.CCCOLLAB_HOSTED_URL = 'https://env.example.com'
    process.env.CCCOLLAB_AUTH_TOKEN = 'env-token'
    process.env.CCCOLLAB_AUTH_REFRESH_TOKEN = 'env-refresh'
    const cfg = loadHostedConfig()
    expect(cfg!.hostedUrl).toBe('https://env.example.com')
    expect(cfg!.accessToken).toBe('env-token')
    expect(cfg!.refreshToken).toBe('env-refresh')
  })

  it('returns empty-token config when URL is set but no tokens exist', () => {
    process.env.CCCOLLAB_HOSTED_URL = 'https://env.example.com'
    const cfg = loadHostedConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.hostedUrl).toBe('https://env.example.com')
    expect(cfg!.accessToken).toBe('')
    expect(cfg!.refreshToken).toBe('')
  })

  it('summary hides tokens and reports source', () => {
    saveHostedConfig({
      hostedUrl: 'https://file.example.com',
      accessToken: 'a',
      refreshToken: 'b',
      userEmail: 'stefan@flatout.solutions',
      updatedAt: 1,
    })
    const sumFile = summarizeHostedConfig()
    expect(sumFile!.hasAccessToken).toBe(true)
    expect(sumFile!.hasRefreshToken).toBe(true)
    expect(sumFile!.source).toBe('file')
    expect(JSON.stringify(sumFile)).not.toMatch(/"a"|"b"/)

    process.env.CCCOLLAB_HOSTED_URL = 'https://env.example.com'
    const sumMixed = summarizeHostedConfig()
    expect(sumMixed!.source).toBe('mixed')
  })

  it('tolerates a corrupted config file by returning null', () => {
    writeFileSync(CCCOLLAB_CONFIG_FILE, '{ not valid json')
    chmodSync(CCCOLLAB_CONFIG_FILE, 0o600)
    expect(loadHostedConfig()).toBeNull()
  })
})
