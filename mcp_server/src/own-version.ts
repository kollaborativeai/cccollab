/**
 * This binary's own version, read from the package manifest that ships beside
 * it. Shared by the server (which compares it against the loaded plugin) and
 * `cccollab doctor` (which reports it), so the two can never disagree about
 * what "this binary" is.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/**
 * Resolves to `<package>/package.json` from either layout: `src/` under tsx in
 * development, or `dist/` after a build. Both sit one directory below the
 * package root.
 */
export function ownVersion(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const version: unknown = (require(manifest) as { version?: unknown }).version
    return typeof version === 'string' ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}
