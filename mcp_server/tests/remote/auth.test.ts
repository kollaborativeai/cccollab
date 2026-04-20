import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect HOME before importing the modules so config writes land in
// a tmp directory.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-auth-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { runAuthenticate } = await import('../../src/remote/auth.js')
const { clearUserConfig } = await import('../../src/config/save.js')
const { CCCOLLAB_CONFIG_FILE } = await import('../../src/constants.js')

function loadPersistedLocation(name: string): { accessToken?: string; refreshToken?: string; url?: string } | null {
  if (!existsSync(CCCOLLAB_CONFIG_FILE)) return null
  const content = JSON.parse(readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8'))
  return content?.locations?.[name] ?? null
}

describe('runAuthenticate', () => {
  beforeEach(() => {
    clearUserConfig()
    delete process.env.CCCOLLAB_REMOTE_URL
    delete process.env.CCCOLLAB_AUTH_TOKEN
  })

  afterEach(() => {
    clearUserConfig()
  })

  afterAll(() => {
    rmSync(TMP_HOME, { recursive: true, force: true })
  })

  it('completes the two-step flow and persists tokens under the given location name', async () => {
    const action = vi
      .fn()
      .mockImplementationOnce(async () => ({
        redirect: 'https://auth.google.example/consent?state=abc',
        verifier: 'verifier-xyz',
      }))
      .mockImplementationOnce(async (_ref, args: { params: { code: string }; verifier: string }) => {
        // The second call must include the verifier we were handed.
        expect(args.verifier).toBe('verifier-xyz')
        expect(args.params.code).toBe('the-code')
        return { tokens: { token: 'new-access', refreshToken: 'new-refresh' } }
      })

    // openUrl fires the "user completed Google" redirect back to our
    // loopback listener. We detect the URL from the first signIn call
    // and hit it in the test to simulate the browser.
    const openUrl = vi.fn(async (url: string) => {
      void url
      const redirect = (action.mock.calls[0]![1] as { params: { redirectTo: string } }).params.redirectTo
      const hitUrl = `${redirect}?code=the-code`
      await fetch(hitUrl)
    })

    const log: string[] = []
    const result = await runAuthenticate({
      locationName: 'flatout',
      url: 'https://wonderful-narwhal-409.convex.cloud',
      httpClient: { action } as never,
      openUrl,
      log: (m) => log.push(m),
      timeoutMs: 5_000,
    })

    expect(result.locationName).toBe('flatout')
    expect(result.url).toBe('https://wonderful-narwhal-409.convex.cloud')
    expect(action).toHaveBeenCalledTimes(2)

    const persisted = loadPersistedLocation('flatout')
    expect(persisted).not.toBeNull()
    expect(persisted!.accessToken).toBe('new-access')
    expect(persisted!.refreshToken).toBe('new-refresh')
    expect(persisted!.url).toBe('https://wonderful-narwhal-409.convex.cloud')
    // Log must not leak tokens
    expect(log.join('\n')).not.toContain('new-access')
    expect(log.join('\n')).not.toContain('new-refresh')
  })

  it('rejects when the second signIn returns no tokens', async () => {
    const action = vi
      .fn()
      .mockImplementationOnce(async () => ({ redirect: 'https://example/', verifier: 'v' }))
      .mockImplementationOnce(async () => ({ tokens: null }))

    const openUrl = vi.fn(async () => {
      const redirect = (action.mock.calls[0]![1] as { params: { redirectTo: string } }).params.redirectTo
      await fetch(`${redirect}?code=abc`)
    })

    await expect(
      runAuthenticate({
        locationName: 'flatout',
        url: 'https://example.convex.cloud',
        httpClient: { action } as never,
        openUrl,
        log: () => {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/did not return tokens/)
    expect(loadPersistedLocation('flatout')).toBeNull()
  })

  it('rejects when the first signIn call fails', async () => {
    const action = vi.fn().mockRejectedValue(new Error('network down'))
    const openUrl = vi.fn(async () => {
      throw new Error('should not open')
    })
    await expect(
      runAuthenticate({
        locationName: 'flatout',
        url: 'https://example.convex.cloud',
        httpClient: { action } as never,
        openUrl,
        log: () => {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/Could not start Convex sign-in/)
  })

  it('rejects when no code arrives within the timeout', async () => {
    const action = vi.fn().mockImplementationOnce(async () => ({ redirect: 'https://example/', verifier: 'v' }))

    const openUrl = vi.fn(async () => {
      /* do nothing - simulate the user closing the browser */
    })

    await expect(
      runAuthenticate({
        locationName: 'flatout',
        url: 'https://example.convex.cloud',
        httpClient: { action } as never,
        openUrl,
        log: () => {},
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/Timed out/)
    expect(action).toHaveBeenCalledTimes(1)
  })
})
