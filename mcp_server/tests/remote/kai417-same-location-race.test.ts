/**
 * KAI-417 F2: the single-use-refresh-token guarantee — the whole reason the
 * config lock exists.
 *
 * Convex/Clerk refresh tokens are SINGLE USE. Two fetchers for the SAME
 * location racing a refresh must result in exactly ONE call to Clerk: the
 * loser must adopt the winner's freshly-persisted tokens from disk (the
 * peer-adoption branch in makeClerkAuthFetcher) rather than POST the same
 * refresh token a second time. A second POST would be rejected by Clerk and
 * force the user to re-authenticate.
 *
 * The existing e2e (kai417-e2e.test.ts) races two DIFFERENT locations, which
 * exercises the deadlock but NOT this invariant — each location legitimately
 * has its own token. Hence this test.
 */
import { expect, test, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_HOME = mkdtempSync(join(tmpdir(), 'kai417-same-loc-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { makeClerkAuthFetcher } = await import('../../src/remote/client.js')
const { CCCOLLAB_CONFIG_FILE, CCCOLLAB_HOME } = await import('../../src/constants.js')

afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }))

function jwt(expSec: number): string {
  return `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`
}

test('two fetchers for the SAME location racing burn exactly one refresh token', async () => {
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  writeFileSync(CCCOLLAB_CONFIG_FILE, JSON.stringify({ locations: {} }))

  const future = Math.floor(Date.now() / 1000) + 3600
  const seen: string[] = []
  const fetchSpy = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    // Record which refresh token was presented, so a second use is visible.
    const sent = new URLSearchParams(init?.body ?? '').get('refresh_token') ?? '?'
    seen.push(sent)
    await new Promise((r) => setTimeout(r, 100)) // keep both in flight
    return new Response(
      JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', id_token: jwt(future), expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetchSpy)

  // Two SEPARATE fetcher instances for the SAME location — i.e. two
  // independent holders of the same single-use refresh token, as two MCP
  // processes (or two transports) would be.
  const mk = () =>
    makeClerkAuthFetcher({
      locationName: 'remote',
      url: 'https://remote.convex.cloud',
      clerkIssuer: 'https://clerk.example.com',
      clerkClientId: 'cid',
      idToken: '',
      refreshToken: 'rt1',
      accessTokenExpiresAt: 0,
    })

  const [a, b] = await Promise.all([mk()({ forceRefreshToken: false }), mk()({ forceRefreshToken: false })])

  expect(a).toBeTruthy()
  expect(b).toBeTruthy()
  // THE INVARIANT: the single-use token was presented to Clerk exactly once.
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(seen).toEqual(['rt1'])
  // The loser adopted the winner's token rather than minting its own.
  expect(a).toBe(b)
}, 20000)
