import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * cccollab is a Kollaborative AI tool (KAI-554). It used to be a FlatOut
 * Solutions one, and the branding leaked into ~250 places across docs,
 * fixtures and install scripts. This test stops it leaking back.
 *
 * It walks every tracked (and every untracked-but-not-ignored) file and
 * fails on any FlatOut Solutions reference outside the allowlist below.
 */

const REPO_ROOT = resolve(__dirname, '..', '..')

/**
 * Paths where a FlatOut Solutions reference is correct and deliberate.
 * Keep this list short and justified - every entry is branding we chose
 * to keep, not branding we failed to clean up.
 */
const ALLOWED_PATHS = new Set([
  // Shared CI tooling, adopted deliberately in KAI-251 and public, so it
  // keeps working once this repo goes public (KAI-555).
  '.github/workflows/ci.yml',
  // This file names the strings it is searching for.
  'mcp_server/tests/branding.test.ts',
])

/**
 * The retired plugin id. It is referenced on purpose in the migration
 * instructions and in install.sh's uninstall step, so it is stripped
 * before the scan rather than allowlisting those whole files.
 */
const RETIRED_PLUGIN_ID = ['cccollab', '@', 'flatoutsolutions'].join('')

const FORBIDDEN = [
  ['flatout', 'solutions'].join(''),
  ['flatout', '.', 'solutions'].join(''),
  ['FlatOut', ' ', 'Solutions'].join(''),
]

/**
 * Names of the author's other companies and clients. These have no business
 * in a public repo, and they leaked in twice: once as fixture location names
 * and once as a display-label map in cctree. Word-bounded so ordinary words
 * that happen to contain them are not flagged.
 */
const FORBIDDEN_CLIENT_NAMES = [
  ['tow', '123'].join(''),
  ['rad', 'pitcrew'].join(''),
  ['pit', 'crew'].join(''),
  ['ta', 'la'].join(''),
]

const clientNamePattern = (needle: string) => new RegExp(`\\b${needle}\\b`, 'i')

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return out.split('\n').filter(Boolean)
}

function readText(path: string): string | undefined {
  try {
    const buf = readFileSync(join(REPO_ROOT, path))
    // Skip binaries: a NUL byte in the first 8KB is the usual heuristic.
    if (buf.subarray(0, 8192).includes(0)) return undefined
    return buf.toString('utf8')
  } catch {
    // Deleted between `git ls-files` and the read, or unreadable. Not our problem.
    return undefined
  }
}

describe('branding', () => {
  it('has no FlatOut Solutions references outside the allowlist', () => {
    const offenders: string[] = []

    for (const path of trackedFiles()) {
      if (ALLOWED_PATHS.has(path)) continue

      const text = readText(path)
      if (text === undefined) continue

      // Deliberate references to the retired plugin id are fine anywhere:
      // users migrating off it need to see the old name.
      const scanned = text.split(RETIRED_PLUGIN_ID).join('')

      for (const needle of FORBIDDEN) {
        if (!scanned.includes(needle)) continue
        const line = scanned.split('\n').findIndex((l) => l.includes(needle)) + 1
        offenders.push(`${path}:${line} contains "${needle}"`)
      }

      for (const needle of FORBIDDEN_CLIENT_NAMES) {
        const re = clientNamePattern(needle)
        if (!re.test(scanned)) continue
        const line = scanned.split('\n').findIndex((l) => re.test(l)) + 1
        offenders.push(`${path}:${line} contains client name "${needle}"`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('flags a client name but not a word that merely contains it', () => {
    const name = ['ta', 'la'].join('')
    expect(clientNamePattern(name).test(`locations: { ${name}: {} }`)).toBe(true)
    expect(clientNamePattern(name).test('const catalared = 1')).toBe(false)
  })

  it('scans a meaningful number of files (guards against a broken git call)', () => {
    // An empty or tiny file list would make the test above pass vacuously.
    expect(trackedFiles().length).toBeGreaterThan(50)
  })

  it('detects a planted reference', () => {
    // Proves the needle actually matches, so a passing suite means "clean",
    // not "the matcher is broken".
    const planted = `author: ${['FlatOut', ' ', 'Solutions'].join('')}`
    expect(FORBIDDEN.some((n) => planted.includes(n))).toBe(true)
  })

  it('does not flag the retired plugin id on its own', () => {
    const migrationDoc = `Uninstall ${RETIRED_PLUGIN_ID} and install cccollab@kollaborativeai.`
    const scanned = migrationDoc.split(RETIRED_PLUGIN_ID).join('')
    expect(FORBIDDEN.some((n) => scanned.includes(n))).toBe(false)
  })
})
