/**
 * Copy the repo-root docs into this package so npm ships them.
 *
 * npm only publishes files inside the package directory, and it only renders a
 * README it finds there — hence "This package does not have a README" on the
 * registry page while a perfectly good one sat two directories up. Symlinks are
 * not a way out: npm dereferences some and drops others depending on version
 * and platform, so the tarball's contents would depend on who packed it.
 *
 * LICENSE and NOTICE travel with it. Apache-2.0 §4(d) requires the NOTICE to be
 * distributed with the work, and a tarball is a distribution.
 *
 * Copies rather than committed duplicates, because two copies of a README in
 * one repo drift and only one of them is ever read. The copies are gitignored;
 * `prepack` regenerates them for every `npm pack` and `npm publish`.
 *
 * Do NOT add `repository.directory: "mcp_server"` to package.json. It is the
 * usual monorepo courtesy, but npm resolves the README's relative links against
 * `repository.url` plus `directory` — and this README is the repo-root one, so
 * every link in it (LICENSE, docs/config.md, …) would resolve one directory too
 * deep and 404 on the registry page.
 */
import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(packageDir, '..')

for (const file of ['README.md', 'LICENSE', 'NOTICE']) {
  copyFileSync(join(repoRoot, file), join(packageDir, file))
  process.stdout.write(`staged ${file}\n`)
}
