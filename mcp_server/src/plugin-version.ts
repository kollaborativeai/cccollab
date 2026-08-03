/**
 * Version handshake between the plugin-bundled skill and this server binary.
 *
 * cccollab ships as two artefacts that install independently: a binary (this
 * process, from Homebrew or npm) and a Claude Code plugin whose
 * `skills/cccollab/SKILL.md` tells the model which tools exist and how to call
 * them. Release CI bumps both to the same version in a single commit, so any
 * difference observed at runtime is install skew — an upgraded binary against
 * a stale cached plugin, or a plugin updated ahead of a pinned binary.
 *
 * Nothing else surfaces that skew. MCP's initialize exchange carries no
 * application version, and a stale skill fails by describing tools whose shape
 * has changed rather than by erroring — so it presents as confusing tool
 * behaviour, not as a version problem. The model works from wrong instructions
 * and no one is told.
 *
 * Claude Code sets CLAUDE_PLUGIN_ROOT in the environment of every server it
 * spawns from a plugin's `.mcp.json`, pointing at the exact cache directory
 * the session loaded its skill from. That is the authoritative link between
 * this process and the document describing it: no version duplicated into
 * `.mcp.json`, nothing for a release script to keep in sync, and it reflects
 * the directory actually loaded rather than the one currently installed.
 */

export type VersionStatus =
  /** No plugin spawned this server — a bare shell run, or a hand-written
   *  `.mcp.json`. There is no skill to be out of step with. */
  | 'standalone'
  /** The loaded skill and this binary are the same version. */
  | 'aligned'
  /** They differ. Either direction is a problem. */
  | 'drifted'
  /** A plugin spawned us, but its manifest cannot be read — typically a cache
   *  directory deleted out from under a live session. */
  | 'unreadable'

export interface VersionState {
  serverVersion: string
  pluginRoot?: string
  pluginVersion?: string
  status: VersionStatus
}

export interface VersionDeps {
  /** Version of the running binary, from this package's own manifest. */
  serverVersion: string
  env: NodeJS.ProcessEnv
  readFile(path: string): string | undefined
}

/**
 * The `version` field of the plugin manifest at `root`, or undefined if the
 * manifest is missing, unparseable, or shaped unexpectedly. Never throws: this
 * runs on the startup path, and a diagnostic must not be able to prevent a
 * working server from starting.
 */
export function readPluginManifestVersion(
  root: string,
  readFile: (path: string) => string | undefined,
): string | undefined {
  const raw = readFile(`${root}/.claude-plugin/plugin.json`)
  if (!raw) return undefined
  try {
    const version: unknown = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

export function inspectVersions(deps: VersionDeps): VersionState {
  const pluginRoot = deps.env.CLAUDE_PLUGIN_ROOT
  if (!pluginRoot) return { serverVersion: deps.serverVersion, status: 'standalone' }

  const pluginVersion = readPluginManifestVersion(pluginRoot, deps.readFile)
  if (!pluginVersion) return { serverVersion: deps.serverVersion, pluginRoot, status: 'unreadable' }

  return {
    serverVersion: deps.serverVersion,
    pluginRoot,
    pluginVersion,
    status: pluginVersion === deps.serverVersion ? 'aligned' : 'drifted',
  }
}

/**
 * A one-paragraph warning for a state worth warning about, or undefined.
 *
 * Deliberately not an error. A drifted skill still describes most of the tool
 * surface correctly, and refusing to serve would turn a degraded session into
 * a dead one — strictly worse than the bug being reported.
 */
export function driftWarning(state: VersionState): string | undefined {
  if (state.status === 'aligned' || state.status === 'standalone') return undefined

  if (state.status === 'unreadable') {
    return (
      `cccollab: this session's plugin directory cannot be read, so the skill guiding it may no longer be on disk.\n` +
      `  plugin: ${state.pluginRoot} (no readable .claude-plugin/plugin.json)\n` +
      `  server: ${state.serverVersion}\n` +
      `Run \`cccollab doctor\` to see what is installed.`
    )
  }

  return (
    `cccollab: version drift. The skill guiding this session is ${state.pluginVersion}, but this server is ${state.serverVersion}.\n` +
    `  plugin: ${state.pluginVersion} (${state.pluginRoot})\n` +
    `  server: ${state.serverVersion}\n` +
    `Tool descriptions the model is working from may not match this server. Run \`cccollab doctor\` to fix.`
  )
}

/**
 * Every distinct CLAUDE_PLUGIN_ROOT in a dump of process environments.
 *
 * Accepts both shapes we read environments in: `ps eww` output (space
 * separated) and Linux `/proc/<pid>/environ` (NUL separated). Deduplicated,
 * because a single stale root is routinely shared by a dozen live sessions and
 * the caller cares whether it is in use at all, not by how many.
 */
export function extractPluginRoots(dump: string): string[] {
  const roots = new Set<string>()
  for (const match of dump.replace(/\0/g, '\n').matchAll(/(?:^|[\s])CLAUDE_PLUGIN_ROOT=(\S+)/g)) {
    roots.add(match[1]!)
  }
  return [...roots]
}

/**
 * Every distinct cccollab launcher path running on this machine, taken from a
 * `ps` dump of command lines.
 *
 * Two servers at different versions can serve different sessions on the same
 * machine at the same time — a Homebrew install and an npm global under a Node
 * version manager, say — and nothing tells either session which one it got.
 * Worse, a process outlives the file it was exec'd from, so a binary uninstalled
 * hours ago can still be answering tool calls.
 *
 * Anchored on a trailing boundary rather than \b so sibling paths that merely
 * start with the launcher name (CLAUDE_PLUGIN_DATA's `cccollab-<marketplace>`)
 * do not match.
 */
export function extractServerBinaries(dump: string): string[] {
  const binaries = new Set<string>()
  for (const match of dump.replace(/\0/g, '\n').matchAll(/(\/\S*\/cccollab(?:\.mjs)?)(?=\s|$)/gm)) {
    binaries.add(match[1]!)
  }
  return [...binaries]
}
