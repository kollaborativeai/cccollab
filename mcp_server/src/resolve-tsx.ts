import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Resolve the path to the `tsx` CLI binary.
 *
 * In a Yarn workspace setup dependencies are hoisted to the repo root, so the
 * tsx binary does not live at `<workspace>/node_modules/.bin/tsx` - it lives
 * at `<repo-root>/node_modules/.bin/tsx`. When installed as an npm package
 * outside a workspace, `node_modules/` is a sibling of the package directory,
 * so the same walk succeeds one level up.
 *
 * Walks upward from `startDir` looking for the first `node_modules/.bin/tsx`
 * it finds. Returns the absolute path on success, or `null` when tsx cannot be
 * located (e.g. the package has been installed without dev dependencies).
 */
export function resolveTsx(startDir: string): string | null {
  let current = startDir
  while (true) {
    const candidate = join(current, 'node_modules', '.bin', 'tsx')
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
