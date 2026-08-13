/**
 * KAI-417 blocker: the Clerk token fetches had NO deadline. Combined with
 * the in-process config-lock mutex, a stalled refresh would (a) queue every
 * other location's fetcher behind it forever and (b) hold the on-disk lock
 * for the whole stall, timing out every foreign cccollab process on the
 * machine. Pre-fix this trades a bounded loud failure for an unbounded
 * silent one, so both token calls must carry an abort deadline.
 */
import { describe, it, expect, vi } from 'vitest'

import { refreshAccessToken, exchangeCodeForTokens } from '../../src/remote/auth-clerk.js'

/** A fetch that never resolves on its own — it only settles when the
 *  caller's AbortSignal fires. If the code under test passes no signal,
 *  this hangs forever (which is exactly the defect). */
function hangingFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return // no deadline => hang forever, as pre-fix
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
    })
  }) as unknown as typeof fetch
}

describe('KAI-417: Clerk token calls are bounded by an abort deadline', () => {
  it('refreshAccessToken rejects when the token endpoint stalls', async () => {
    await expect(
      refreshAccessToken(
        { issuer: 'https://clerk.example.com', clientId: 'cid', refreshToken: 'rt' },
        hangingFetch(),
        50, // short deadline for the test; production default is 10s
      ),
    ).rejects.toThrow()
  })

  it('exchangeCodeForTokens rejects when the token endpoint stalls', async () => {
    await expect(
      exchangeCodeForTokens(
        {
          issuer: 'https://clerk.example.com',
          clientId: 'cid',
          redirectUri: 'http://127.0.0.1:53682/cb',
          code: 'c',
          codeVerifier: 'v',
        },
        hangingFetch(),
        50,
      ),
    ).rejects.toThrow()
  })
})
