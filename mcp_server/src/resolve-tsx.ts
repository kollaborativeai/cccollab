import { createRequire } from 'node:module'
import { join } from 'node:path'

/**
 * Resolve the path to the `tsx` CLI module.
 *
 * Returns the absolute path to tsx's `dist/cli.mjs` (the package's `tsx/cli`
 * subpath export). The caller should invoke it with `process.execPath` as the
 * runtime, e.g. `spawn(process.execPath, [tsxCli, scriptPath])`. This avoids
 * going through `node_modules/.bin/tsx`, which on Windows is a sh shim that
 * `child_process.spawn` cannot exec without `shell: true`.
 *
 * Resolution is rooted at `startDir` and uses Node's standard module lookup,
 * so it transparently handles hoisted workspace installs (tsx at the repo
 * root) and standalone npm installs (tsx as a sibling of the package).
 */
export function resolveTsx(startDir: string): string | null {
  const req = createRequire(join(startDir, '__cccollab_resolve_tsx__.js'))
  try {
    return req.resolve('tsx/cli')
  } catch {
    return null
  }
}
