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

import { delimiter as pathDelimiter, join } from 'node:path'
import {
  inspectVersions,
  driftWarning,
  extractPluginRoots,
  extractServerBinaries,
  type VersionState,
} from './plugin-version.js'

const PLUGIN_NAME = 'cccollab'
const MARKETPLACE = 'kollaborativeai'
const PLUGIN = `${PLUGIN_NAME}@${MARKETPLACE}`

export interface BinaryInstall {
  path: string
  /** Undefined when the binary could not be run to ask. */
  version?: string
}

export interface BinaryFindings {
  /** Every `cccollab` resolvable on PATH, in PATH order. The first wins. */
  onPath: BinaryInstall[]
  /** Launcher paths of cccollab servers currently running. */
  running: string[]
  /** Running from a file that no longer exists on disk. */
  vanished: string[]
  /** More than one distinct `cccollab` is reachable on PATH. */
  shadowed: boolean
}

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
  fileExists(path: string): boolean
  removeDir(path: string): void
  /** A `ps` dump carrying both command lines and environments, read once and
   *  parsed here so the two questions it answers — which plugin roots are
   *  loaded, and which binaries are running — cannot disagree with each other. */
  processDump(): string
  /** Every `cccollab` resolvable on PATH, in PATH order, with its version. */
  listBinariesOnPath(): BinaryInstall[]
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

/**
 * Every `name` reachable on PATH, in PATH order, deduplicated by real path.
 *
 * Walks PATH directly rather than shelling out. `command -v -a` is not POSIX —
 * bash's builtin rejects `-a` — so the shell form failed silently and reported
 * an empty PATH on a machine that plainly had one on it. Deduplicating by real
 * path keeps two PATH entries symlinked to the same file from reading as two
 * competing installs.
 */
export function resolveOnPath(
  name: string,
  pathVar: string | undefined,
  deps: { isExecutable(path: string): boolean; realPath(path: string): string },
  options: { extensions?: string[]; delimiter?: string } = {},
): string[] {
  // Separator and extensions are injectable so both platforms' behaviour can be
  // tested from either. Windows needs PATHEXT: without it the scan finds nothing
  // and reports an empty PATH, which is indistinguishable from "not installed" —
  // the same silent-empty this command exists to eliminate.
  const sep = options.delimiter ?? pathDelimiter
  const extensions = options.extensions ?? ['']
  const seen = new Set<string>()
  const found: string[] = []
  for (const dir of (pathVar ?? '').split(sep)) {
    if (!dir) continue
    for (const ext of extensions) {
      const candidate = join(dir, `${name}${ext}`)
      if (!deps.isExecutable(candidate)) continue
      const real = deps.realPath(candidate)
      if (seen.has(real)) continue
      seen.add(real)
      found.push(candidate)
    }
  }
  return found
}

/**
 * What is serving cccollab on this machine, as opposed to what is installed.
 *
 * Two failure modes live here and neither shows up anywhere else. A second
 * `cccollab` earlier on PATH silently wins for every session Claude Code
 * starts — a Homebrew install and an npm global under a Node version manager
 * is the ordinary way to end up with both. And a running server keeps serving
 * from a binary that has since been uninstalled, because the process holds the
 * inode: the version that answers tool calls is then one no file on disk has.
 */
export function inspectBinaries(deps: DoctorDeps): BinaryFindings {
  const onPath = deps.listBinariesOnPath()
  const running = extractServerBinaries(deps.processDump())
  return {
    onPath,
    running,
    vanished: running.filter((path) => !deps.fileExists(path)),
    shadowed: onPath.length > 1,
  }
}

export function scanCaches(deps: DoctorDeps): CacheEntry[] {
  const root = cacheRoot(deps.homeDir)
  const referenced = new Set(
    referencedInstallPaths(deps.readFile(`${deps.homeDir}/.claude/plugins/installed_plugins.json`)),
  )
  const inUse = new Set(extractPluginRoots(deps.processDump()))

  const entries: CacheEntry[] = []
  for (const marketplace of deps.listDir(root)) {
    const pluginDir = `${root}/${marketplace}/${PLUGIN_NAME}`
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

export interface InstalledPluginState {
  /** Version Claude Code records as installed, if any. */
  version?: string
  path?: string
  status: 'aligned' | 'drifted' | 'missing'
}

/**
 * The installed plugin versus this binary — the drift a user can actually see.
 *
 * The CLAUDE_PLUGIN_ROOT handshake only works inside a server Claude Code
 * spawned, so it is blind in a terminal, which is exactly where `cccollab
 * doctor` is run and exactly what the drift warning tells people to run. On a
 * machine with a 3.6.1 binary and a 3.5.0 plugin, this command printed both
 * numbers two lines apart and reported no problem.
 *
 * Compared by string equality on purpose: release CI writes one version into
 * both manifests in a single commit, so "different" is the whole signal and
 * ordering does not matter.
 */
export function inspectInstalledPlugin(entries: CacheEntry[], serverVersion: string): InstalledPluginState {
  const installed = entries.filter((entry) => entry.referenced)
  if (installed.length === 0) return { status: 'missing' }

  // Two marketplaces can each have a cccollab recorded as installed — the
  // rebrand leaves cccollab@flatoutsolutions behind on any machine where `init`
  // never ran. Prefer the current marketplace so the answer cannot depend on
  // the order the filesystem happened to list directories in.
  const chosen = installed.find((entry) => entry.marketplace === MARKETPLACE) ?? installed[0]!
  return {
    version: chosen.version,
    path: chosen.path,
    status: chosen.version === serverVersion ? 'aligned' : 'drifted',
  }
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
  return new RegExp(`^${escapeForRegExp(root)}/[^/]+/${PLUGIN_NAME}/[^/]+$`).test(path)
}

const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function runDoctor(options: DoctorOptions, deps: DoctorDeps): Promise<number> {
  const state = inspectVersions({ serverVersion: deps.serverVersion, env: deps.env, readFile: deps.readFile })
  const binaries = inspectBinaries(deps)
  const entries = scanCaches(deps)
  const installed = inspectInstalledPlugin(entries, deps.serverVersion)

  deps.log(report(state, binaries, entries, installed, deps))

  const warning = driftWarning(state)
  if (warning) deps.log(`\n${warning}`)

  if (installed.status === 'drifted') {
    deps.log(
      `\nThe installed cccollab plugin is ${installed.version}, but this binary is ${deps.serverVersion}.\n` +
        `Every session started from now on loads a skill that does not describe this\n` +
        `server. Fix it with:\n` +
        `\n    claude plugin marketplace update ${MARKETPLACE}` +
        `\n    claude plugin update ${PLUGIN}\n` +
        `\nThen restart Claude Code — a running session keeps the skill it loaded.`,
    )
  }

  if (installed.status === 'missing') {
    deps.log(
      `\nNo cccollab plugin is installed, so Claude Code has none of these tools —\n` +
        `the binary alone does nothing. Run:\n` +
        `\n    cccollab init\n`,
    )
  }

  if (binaries.shadowed) {
    const [first, ...rest] = binaries.onPath
    deps.log(
      `\nMore than one cccollab is on PATH. Claude Code runs the first, so that is the\n` +
        `one serving your sessions:\n` +
        `  ${describeBinary(first!)}  <- wins\n` +
        rest.map((b) => `  ${describeBinary(b)}`).join('\n') +
        `\nRemove the ones you do not want, or reorder PATH. Installing with a Node\n` +
        `version manager and with Homebrew is the usual way to end up with both.`,
    )
  }

  if (binaries.vanished.length > 0) {
    deps.log(
      `\n${binaries.vanished.length} ${plural(binaries.vanished.length, 'binary', 'binaries')} still serving live sessions no longer ${plural(binaries.vanished.length, 'exists', 'exist')} on\n` +
        `disk — uninstalled or replaced while the processes kept running, so the version\n` +
        `answering their tool calls is whatever it was at launch and cannot be checked:\n` +
        binaries.vanished.map((path) => `  ${path}`).join('\n') +
        `\nRestart those sessions to pick up the installed version.`,
    )
  }

  const stale = prunable(entries)
  const held = entries.filter((e) => e.inUse && !e.referenced)
  if (held.length > 0) {
    deps.log(
      `\n${held.length} older ${plural(held.length, 'copy', 'copies')} left in place because a running session is using ${plural(held.length, 'it', 'them')}:\n` +
        held.map((e) => `  ${e.marketplace}/${e.version}  (in use)`).join('\n') +
        `\nThese clear themselves once those sessions restart.`,
    )
  }

  let problems = warning || binaries.shadowed || binaries.vanished.length > 0 || installed.status !== 'aligned' ? 1 : 0

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

const describeBinary = (install: BinaryInstall) =>
  `${install.path}${install.version ? `  (${install.version})` : '  (version unknown)'}`

function report(
  state: VersionState,
  binaries: BinaryFindings,
  entries: CacheEntry[],
  installed: InstalledPluginState,
  deps: DoctorDeps,
): string {
  const lines = [
    'cccollab doctor',
    '',
    `  binary   ${deps.serverVersion}  (${deps.binaryPath})`,
    installed.status === 'missing'
      ? '  plugin   not installed — run `cccollab init`'
      : `  plugin   ${installed.version}  (installed)`,
    state.status === 'standalone'
      ? '  skill    not loaded here (no CLAUDE_PLUGIN_ROOT — this is a terminal, not a session)'
      : `  skill    ${state.pluginVersion ?? 'unreadable'}  (${state.pluginRoot})`,
    '',
    binaries.onPath.length === 0 ? '  no cccollab found on PATH' : '  on PATH:',
  ]
  for (const [index, install] of binaries.onPath.entries()) {
    lines.push(`    ${describeBinary(install)}${index === 0 && binaries.onPath.length > 1 ? '  [wins]' : ''}`)
  }
  lines.push('', entries.length === 0 ? '  no cached plugin copies found' : '  cached plugin copies:')
  for (const entry of entries) {
    const tags = [entry.referenced ? 'installed' : undefined, entry.inUse ? 'in use' : undefined].filter(Boolean)
    lines.push(`    ${entry.marketplace}/${entry.version}${tags.length ? `  [${tags.join(', ')}]` : ''}`)
  }
  return lines.join('\n')
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)
