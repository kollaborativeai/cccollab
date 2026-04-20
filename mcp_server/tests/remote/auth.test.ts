import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect HOME before importing the modules so config writes land in
// a tmp directory. See tests/remote/config.test.ts for the rationale.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-auth-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { runAuthenticate } = await import('../../src/remote/auth.js')
const { loadRemoteConfig, clearRemoteConfig } = await import('../../src/remote/config.js')

describe('runAuthenticate', () => {
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

  it('completes the two-step flow and persists tokens', async () => {
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
      remoteUrl: 'https://wonderful-narwhal-409.convex.cloud',
      httpClient: { action } as never,
      openUrl,
      log: (m) => log.push(m),
      timeoutMs: 5_000,
    })

    expect(result.remoteUrl).toBe('https://wonderful-narwhal-409.convex.cloud')
    expect(action).toHaveBeenCalledTimes(2)

    const persisted = loadRemoteConfig()
    expect(persisted).not.toBeNull()
    expect(persisted!.accessToken).toBe('new-access')
    expect(persisted!.refreshToken).toBe('new-refresh')
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
        remoteUrl: 'https://example.convex.cloud',
        httpClient: { action } as never,
        openUrl,
        log: () => {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/did not return tokens/)
    expect(loadRemoteConfig()).toBeNull()
  })

  it('rejects when the first signIn call fails', async () => {
    const action = vi.fn().mockRejectedValue(new Error('network down'))
    const openUrl = vi.fn(async () => {
      throw new Error('should not open')
    })
    await expect(
      runAuthenticate({
        remoteUrl: 'https://example.convex.cloud',
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
        remoteUrl: 'https://example.convex.cloud',
        httpClient: { action } as never,
        openUrl,
        log: () => {},
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/Timed out/)
    expect(action).toHaveBeenCalledTimes(1)
  })
})
