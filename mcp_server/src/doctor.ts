/**
 * `cccollab doctor` — report what cccollab is actually installed on this
 * machine, and optionally remove the copies nothing is using.
 *
 * Claude Code caches every plugin version it has ever installed under
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, and removes
 * none of them: `plugin update` adds the new version beside the old, and
 * `plugin uninstall` leaves the whole tree behind. Each copy carries its own
 * `skills/cccollab/SKILL.md`, so the pile is not wasted disk — it is a set of
 * conflicting instruction documents, any of which a session may be loaded
 * against. Moving the plugin to a different marketplace, as the rebrand did,
 * multiplies them again under a second path.
 *
 * The single rule that governs deletion here: a version a live session is
 * running from is never removed, whatever the bookkeeping says. Pruning by
 * `installed_plugins.json` alone is exactly the mistake that deleted the
 * plugin roots of eighteen running sessions on the machine this bug was
 * reported from. The bookkeeping records what is installed; it says nothing
 * about what is loaded.
 */

import { inspectVersions, driftWarning, type VersionState } from './plugin-version.js'

const PLUGIN = 'cccollab'

export interface DoctorOptions {
  /** Remove unused cached copies. Never implied — reporting is the default. */
  prune: boolean
  /** Assume yes for the deletion prompt. */
  yes: boolean
}

export interface DoctorDeps {
  readFile(path: string): string | undefined
  /** Entries of a directory; empty when it does not exist. Never throws. */
  listDir(path: string): string[]
  isDirectory(path: string): boolean
  removeDir(path: string): void
  /** CLAUDE_PLUGIN_ROOT of every live cccollab server on this machine. */
  runningPluginRoots(): string[]
  confirm(question: string): Promise<boolean>
  log(message: string): void
  homeDir: string
  serverVersion: string
  binaryPath: string
  env: NodeJS.ProcessEnv
}

export interface CacheEntry {
  path: string
  marketplace: string
  version: string
  /** Recorded as installed in `installed_plugins.json`. */
  referenced: boolean
  /** A running session was spawned against this directory. */
  inUse: boolean
}

export function parseDoctorArgs(argv: string[]): DoctorOptions {
  return {
    prune: argv.includes('--prune'),
    yes: argv.includes('--yes') || argv.includes('-y'),
  }
}

const cacheRoot = (homeDir: string) => `${homeDir}/.claude/plugins/cache`

/**
 * Every `installPath` recorded anywhere in Claude Code's plugin bookkeeping.
 * Shape-tolerant by design: this file is Claude Code's, not ours, and a schema
 * change must degrade to "nothing is referenced" rather than throw. That
 * direction is safe — an unreferenced-looking entry is still protected from
 * deletion by the in-use check.
 */
export function referencedInstallPaths(raw: string | undefined): string[] {
  if (!raw) return []
  const found = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk)
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'installPath' && typeof value === 'string') found.add(value)
        else walk(value)
      }
    }
  }
  try {
    walk(JSON.parse(raw))
  } catch {
    return []
  }
  return [...found]
}

export function scanCaches(deps: DoctorDeps): CacheEntry[] {
  const root = cacheRoot(deps.homeDir)
  const referenced = new Set(
    referencedInstallPaths(deps.readFile(`${deps.homeDir}/.claude/plugins/installed_plugins.json`)),
  )
  const inUse = new Set(deps.runningPluginRoots())

  const entries: CacheEntry[] = []
  for (const marketplace of deps.listDir(root)) {
    const pluginDir = `${root}/${marketplace}/${PLUGIN}`
    if (!deps.isDirectory(pluginDir)) continue
    for (const version of deps.listDir(pluginDir)) {
      const path = `${pluginDir}/${version}`
      if (!deps.isDirectory(path)) continue
      entries.push({
        path,
        marketplace,
        version,
        referenced: referenced.has(path),
        inUse: inUse.has(path),
      })
    }
  }
  return entries
}

/** Copies safe to delete: neither installed nor loaded by a live session. */
export function prunable(entries: CacheEntry[]): CacheEntry[] {
  return entries.filter((e) => !e.referenced && !e.inUse)
}

/**
 * True when `path` is a well-formed cccollab cache directory under `root`.
 * Guards the delete loop against a traversal arriving through a directory
 * listing, so malformed input can only ever cause us to skip, never to reach
 * outside the cache.
 */
function isSafeCachePath(path: string, root: string): boolean {
  if (path.includes('..')) return false
  if (!path.startsWith(`${root}/`)) return false
  return new RegExp(`^${escapeForRegExp(root)}/[^/]+/${PLUGIN}/[^/]+$`).test(path)
}

const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function runDoctor(options: DoctorOptions, deps: DoctorDeps): Promise<number> {
  const state = inspectVersions({ serverVersion: deps.serverVersion, env: deps.env, readFile: deps.readFile })
  const entries = scanCaches(deps)

  deps.log(report(state, entries, deps))

  const warning = driftWarning(state)
  if (warning) deps.log(`\n${warning}`)

  const stale = prunable(entries)
  const held = entries.filter((e) => e.inUse && !e.referenced)
  if (held.length > 0) {
    deps.log(
      `\n${held.length} older ${plural(held.length, 'copy', 'copies')} left in place because a running session is using ${plural(held.length, 'it', 'them')}:\n` +
        held.map((e) => `  ${e.marketplace}/${e.version}  (in use)`).join('\n') +
        `\nThese clear themselves once those sessions restart.`,
    )
  }

  let problems = warning ? 1 : 0

  if (stale.length === 0) {
    if (entries.length > 0 && held.length === 0) deps.log('\nNo stale copies. Nothing to clean up.')
    return problems > 0 ? 1 : 0
  }

  if (!options.prune) {
    deps.log(
      `\n${stale.length} unused ${plural(stale.length, 'copy', 'copies')} could be removed:\n` +
        stale.map((e) => `  ${e.path}`).join('\n') +
        `\n\nRemove them with:  cccollab doctor --prune`,
    )
    return 1
  }

  const listed = stale.map((e) => `  ${e.path}`).join('\n')
  const wanted =
    options.yes ||
    (await deps.confirm(
      `Delete ${stale.length} unused cccollab ${plural(stale.length, 'copy', 'copies')}?\n${listed}\n[y/N] `,
    ))
  if (!wanted) {
    deps.log('\nLeaving the cache untouched.')
    return 1
  }

  const root = cacheRoot(deps.homeDir)
  let removed = 0
  for (const entry of stale) {
    if (!isSafeCachePath(entry.path, root)) {
      deps.log(`Skipping ${entry.path}: not a cccollab cache directory.`)
      problems = 1
      continue
    }
    deps.removeDir(entry.path)
    deps.log(`Removed ${entry.marketplace}/${entry.version}`)
    removed += 1
  }
  deps.log(`\nRemoved ${removed} unused ${plural(removed, 'copy', 'copies')}.`)
  return problems > 0 ? 1 : 0
}

function report(state: VersionState, entries: CacheEntry[], deps: DoctorDeps): string {
  const lines = [
    'cccollab doctor',
    '',
    `  binary   ${deps.serverVersion}  (${deps.binaryPath})`,
    state.status === 'standalone'
      ? '  skill    not spawned by a plugin (no CLAUDE_PLUGIN_ROOT)'
      : `  skill    ${state.pluginVersion ?? 'unreadable'}  (${state.pluginRoot})`,
    '',
    entries.length === 0 ? '  no cached plugin copies found' : '  cached plugin copies:',
  ]
  for (const entry of entries) {
    const tags = [entry.referenced ? 'installed' : undefined, entry.inUse ? 'in use' : undefined].filter(Boolean)
    lines.push(`    ${entry.marketplace}/${entry.version}${tags.length ? `  [${tags.join(', ')}]` : ''}`)
  }
  return lines.join('\n')
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)
