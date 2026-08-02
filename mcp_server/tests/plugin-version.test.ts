import { describe, it, expect } from 'vitest'
import {
  extractPluginRoots,
  inspectVersions,
  driftWarning,
  readPluginManifestVersion,
  type VersionDeps,
} from '../src/plugin-version.js'

const ROOT = '/home/dev/.claude/plugins/cache/kollaborativeai/cccollab/3.4.0'

function deps(overrides: Partial<VersionDeps> = {}): VersionDeps {
  return {
    serverVersion: '3.5.0',
    env: { CLAUDE_PLUGIN_ROOT: ROOT },
    readFile: (path) => (path === `${ROOT}/.claude-plugin/plugin.json` ? '{"version": "3.4.0"}' : undefined),
    ...overrides,
  }
}

describe('readPluginManifestVersion', () => {
  it('reads the version out of a plugin manifest', () => {
    const read = () => '{"name": "cccollab", "version": "3.4.0"}'
    expect(readPluginManifestVersion('/root', read)).toBe('3.4.0')
  })

  it('returns undefined when the manifest is missing', () => {
    expect(readPluginManifestVersion('/root', () => undefined)).toBeUndefined()
  })

  it('returns undefined rather than throwing on malformed JSON', () => {
    // A half-written manifest must not take the server down on startup; the
    // handshake is diagnostic, never load-bearing.
    expect(readPluginManifestVersion('/root', () => '{ not json')).toBeUndefined()
  })

  it('returns undefined when the manifest has no version field', () => {
    expect(readPluginManifestVersion('/root', () => '{"name": "cccollab"}')).toBeUndefined()
  })

  it('returns undefined when version is not a string', () => {
    expect(readPluginManifestVersion('/root', () => '{"version": 3}')).toBeUndefined()
  })
})

describe('inspectVersions', () => {
  it('reports standalone when no plugin spawned this server', () => {
    // `cccollab` run straight from a shell, or from a non-plugin .mcp.json.
    // There is no skill to be out of step with, so there is nothing to warn about.
    const state = inspectVersions(deps({ env: {} }))
    expect(state.status).toBe('standalone')
    expect(state.serverVersion).toBe('3.5.0')
    expect(state.pluginVersion).toBeUndefined()
  })

  it('reports aligned when the loaded skill matches this binary', () => {
    const state = inspectVersions(deps({ readFile: () => '{"version": "3.5.0"}' }))
    expect(state.status).toBe('aligned')
    expect(state.pluginVersion).toBe('3.5.0')
    expect(state.pluginRoot).toBe(ROOT)
  })

  it('reports drifted when the loaded skill is a different version', () => {
    const state = inspectVersions(deps())
    expect(state.status).toBe('drifted')
    expect(state.pluginVersion).toBe('3.4.0')
    expect(state.serverVersion).toBe('3.5.0')
  })

  it('reports drifted when the skill is NEWER than the binary', () => {
    // The reverse skew is just as wrong and just as silent: a plugin updated
    // ahead of a pinned or stale binary describes tools this server lacks.
    const state = inspectVersions(deps({ serverVersion: '3.4.0', readFile: () => '{"version": "3.5.0"}' }))
    expect(state.status).toBe('drifted')
  })

  it('reports unreadable when the plugin root is set but its manifest is gone', () => {
    // Exactly what a hand-pruned plugin cache leaves behind: the session was
    // spawned against a directory that no longer exists.
    const state = inspectVersions(deps({ readFile: () => undefined }))
    expect(state.status).toBe('unreadable')
    expect(state.pluginRoot).toBe(ROOT)
    expect(state.pluginVersion).toBeUndefined()
  })

  it('treats an empty CLAUDE_PLUGIN_ROOT as standalone', () => {
    expect(inspectVersions(deps({ env: { CLAUDE_PLUGIN_ROOT: '' } })).status).toBe('standalone')
  })
})

describe('driftWarning', () => {
  it('says nothing when aligned', () => {
    expect(driftWarning(inspectVersions(deps({ readFile: () => '{"version": "3.5.0"}' })))).toBeUndefined()
  })

  it('says nothing when standalone', () => {
    expect(driftWarning(inspectVersions(deps({ env: {} })))).toBeUndefined()
  })

  it('names both versions and the command that fixes it', () => {
    const warning = driftWarning(inspectVersions(deps()))
    expect(warning).toBeDefined()
    expect(warning).toContain('3.4.0')
    expect(warning).toContain('3.5.0')
    expect(warning).toContain('cccollab doctor')
  })

  it('names the missing directory when the manifest is unreadable', () => {
    const warning = driftWarning(inspectVersions(deps({ readFile: () => undefined })))
    expect(warning).toBeDefined()
    expect(warning).toContain(ROOT)
    expect(warning).toContain('cccollab doctor')
  })
})

describe('extractPluginRoots', () => {
  it('pulls every plugin root out of a space-separated ps env dump', () => {
    const dump = `PID TTY STAT TIME COMMAND\n 60888 ?? Ss 0:01.20 node /opt/homebrew/bin/cccollab CLAUDECODE=1 CLAUDE_PLUGIN_ROOT=/cache/a/cccollab/3.2.3 PWD=/repo`
    expect(extractPluginRoots(dump)).toEqual(['/cache/a/cccollab/3.2.3'])
  })

  it('handles NUL-separated /proc environ dumps', () => {
    const dump = `CLAUDECODE=1\0CLAUDE_PLUGIN_ROOT=/cache/b/cccollab/3.4.0\0PWD=/repo\0`
    expect(extractPluginRoots(dump)).toEqual(['/cache/b/cccollab/3.4.0'])
  })

  it('deduplicates roots shared by several sessions', () => {
    // Fifteen sessions on one stale root must count once, not fifteen times.
    const dump = ['CLAUDE_PLUGIN_ROOT=/cache/a', 'CLAUDE_PLUGIN_ROOT=/cache/a', 'CLAUDE_PLUGIN_ROOT=/cache/b'].join(
      '\n',
    )
    expect(extractPluginRoots(dump)).toEqual(['/cache/a', '/cache/b'])
  })

  it('returns nothing for a dump with no plugin roots', () => {
    expect(extractPluginRoots('PID TTY\n123 ??')).toEqual([])
  })

  it('does not match a variable that merely ends in CLAUDE_PLUGIN_ROOT', () => {
    expect(extractPluginRoots('MY_CLAUDE_PLUGIN_ROOT=/nope')).toEqual([])
  })
})
