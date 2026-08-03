import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The `mcp_server` path filter in CI's `detect-changes` job decides whether a
 * push to main publishes a new @kollaborativeai/cccollab. It used to be the
 * broad `mcp_server/**`, which also matched `mcp_server/tests/**` - so a
 * test-only change cut a release whose tarball was byte-identical to the one
 * before it. v3.6.4 shipped exactly that way (KAI-573).
 *
 * The filter lives in YAML that nothing type-checks and that no test would
 * otherwise touch, and the failure is silent in the direction that costs a
 * version number. This locks the classification down.
 */

const REPO_ROOT = resolve(__dirname, '..', '..')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml')

/**
 * Pull one named filter's globs out of the `filters: |` block scalar that
 * detect-changes hands to dorny/paths-filter. Deliberately reads the real
 * workflow rather than a copy: a fixture would drift from the file that
 * actually runs, which is the only file this test exists to constrain.
 */
function readFilterPatterns(filterName: string): string[] {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')

  const blockStart = lines.findIndex((line) => /^\s*filters:\s*\|\s*$/.test(line))
  expect(blockStart, 'detect-changes no longer has a `filters: |` block').toBeGreaterThan(-1)

  const header = new RegExp(`^(\\s+)${filterName}:\\s*$`)
  const patterns: string[] = []
  let indent: number | null = null

  for (const line of lines.slice(blockStart + 1)) {
    if (indent === null) {
      const headerIndent = header.exec(line)?.[1]
      if (headerIndent !== undefined) indent = headerIndent.length
      continue
    }
    // A sibling filter name (same indent, not a list item) ends this one, and
    // so does leaving the block scalar entirely.
    const entry = /^(\s+)- '(.+)'\s*$/.exec(line)
    const entryIndent = entry?.[1]
    const entryPattern = entry?.[2]
    if (entryIndent !== undefined && entryPattern !== undefined && entryIndent.length > indent) {
      patterns.push(entryPattern)
      continue
    }
    if (line.trim() === '') continue
    break
  }

  expect(patterns.length, `no patterns found for filter "${filterName}"`).toBeGreaterThan(0)
  return patterns
}

/**
 * Minimal glob matcher covering only the shapes this filter uses: `**`, a
 * single-segment `*`, and literals. It throws on anything richer rather than
 * guessing, because a pattern this cannot model would otherwise be silently
 * misclassified and the test would go on passing while the filter misbehaved.
 *
 * `!` negation is rejected on purpose - see the dedicated test below.
 */
function globToRegExp(pattern: string): RegExp {
  if (/[!?+@([{]/.test(pattern)) {
    throw new Error(
      `Unsupported glob syntax in CI filter pattern "${pattern}". ` +
        `This matcher models only \`**\`, \`*\` and literals. If the filter now ` +
        `needs richer globs, teach this matcher before relying on it.`,
    )
  }
  const escape = (literal: string) => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = pattern
    .split('**')
    .map((between) => between.split('*').map(escape).join('[^/]*'))
    .join('.*')
  return new RegExp(`^${body}$`)
}

/** dorny/paths-filter's default `predicate-quantifier: some` - plain OR. */
function matchesFilter(patterns: string[], path: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path))
}

describe('CI mcp_server release filter', () => {
  const patterns = readFilterPatterns('mcp_server')

  it.each([
    'mcp_server/src/server.ts',
    'mcp_server/bin/cccollab.mjs',
    'mcp_server/scripts/stage-docs.mjs',
    'mcp_server/package.json',
    'mcp_server/tsconfig.json',
    'mcp_server/tsconfig.build.json',
    'plugin/.claude-plugin/plugin.json',
    'yarn.lock',
    // Staged into the package by scripts/stage-docs.mjs at prepack, so editing
    // one changes the tarball. Omitting them left npm serving a README that
    // drifted from the repo's - the defect KAI-561 was opened to fix.
    'README.md',
    'LICENSE',
    'NOTICE',
  ])('releases on %s, which can change the published tarball', (path) => {
    expect(matchesFilter(patterns, path)).toBe(true)
  })

  it.each([
    'mcp_server/tests/doctor.e2e.test.ts',
    'mcp_server/tests/remote/client-clerk.test.ts',
    'mcp_server/vitest.config.ts',
    'mcp_server/eslint.config.js',
    'website/index.html',
    // Only README, LICENSE and NOTICE are staged into the package. These guard
    // against the allowlist being loosened to something like '*.md', which would
    // put every doc and the code of conduct back on the release path.
    'docs/config.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
  ])('does not release on %s, which never reaches the package', (path) => {
    expect(matchesFilter(patterns, path)).toBe(false)
  })

  it('does not use the broad mcp_server/** glob that shipped v3.6.4', () => {
    expect(patterns).not.toContain('mcp_server/**')
  })

  it('uses no negative patterns, which cannot subtract under predicate-quantifier: some', () => {
    // dorny/paths-filter ORs a filter's patterns together, so `!a/b/**` does not
    // remove anything - the excluded file still matches the positive pattern and
    // still fires, while every unrelated path (website/, docs/) now matches the
    // negation and fires too. Switching to `every` is not an escape: no single
    // path can match both `mcp_server/src/**` and `plugin/**`, so the filter
    // would stop firing altogether. An allowlist is the only shape that works.
    expect(patterns.filter((pattern) => pattern.startsWith('!'))).toEqual([])
  })
})
