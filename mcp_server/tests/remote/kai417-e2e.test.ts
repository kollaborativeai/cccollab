/**
 * KAI-417 bug 1, exercised through the REAL production path: two remote
 * locations, each with its own Clerk auth fetcher (makeClerkAuthFetcher),
 * both refreshing concurrently at startup -- the exact scenario that
 * deadlocked the MCP server. Not a direct test of withConfigLock.
 */
import { expect, test, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_HOME = mkdtempSync(join(tmpdir(), 'kai417-e2e-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { makeClerkAuthFetcher } = await import('../../src/remote/client.js')
const { CCCOLLAB_CONFIG_FILE, CCCOLLAB_HOME } = await import('../../src/constants.js')

afterAll(() => rmSync(TMP_HOME, { recursive: true, force: true }))

function jwt(expSec: number): string {
  return `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`
}

test('two remote locations refreshing concurrently do not deadlock', async () => {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  writeFileSync(CCCOLLAB_CONFIG_FILE, JSON.stringify({ locations: {} }))

  const future = Math.floor(Date.now() / 1000) + 3600
  // Clerk stub, deliberately slow so both refreshes are genuinely in flight
  // at the same time -- that overlap is what triggered the deadlock.
  const fetchSpy = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 100))
    return new Response(
      JSON.stringify({ access_token: 'at', refresh_token: 'rt2', id_token: jwt(future), expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetchSpy)

  const mkLoc = (name: string) =>
    makeClerkAuthFetcher({
      locationName: name,
      url: `https://${name}.convex.cloud`,
      clerkIssuer: 'https://clerk.example.com',
      clerkClientId: 'cid',
      idToken: '', // empty => a real refresh is forced, as at server startup
      refreshToken: 'rt1',
      accessTokenExpiresAt: 0,
    })

  const started = Date.now()
  const [alpha, beta] = await Promise.all([
    mkLoc('alpha')({ forceRefreshToken: false }),
    mkLoc('beta')({ forceRefreshToken: false }),
  ])
  const elapsed = Date.now() - started

  expect(alpha).toBeTruthy()
  expect(beta).toBeTruthy()
  expect(fetchSpy).toHaveBeenCalledTimes(2)
  // The deadlock burned the full LOCK_TIMEOUT_MS (5000ms) and returned null.
  expect(elapsed).toBeLessThan(4000)
}, 20000)
