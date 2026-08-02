import { describe, it, expect } from 'vitest'
import {
  inspectBinaries,
  parseDoctorArgs,
  referencedInstallPaths,
  resolveOnPath,
  scanCaches,
  prunable,
  runDoctor,
  type DoctorDeps,
} from '../src/doctor.js'

const HOME = '/home/dev'
const CACHE = `${HOME}/.claude/plugins/cache`

/** A cache tree described as marketplace -> versions. */
function tree(layout: Record<string, string[]>) {
  return {
    listDir(path: string): string[] {
      if (path === CACHE) return Object.keys(layout)
      for (const [marketplace, versions] of Object.entries(layout)) {
        if (path === `${CACHE}/${marketplace}/cccollab`) return versions
      }
      return []
    },
    isDirectory(path: string): boolean {
      for (const [marketplace, versions] of Object.entries(layout)) {
        if (path === `${CACHE}/${marketplace}` || path === `${CACHE}/${marketplace}/cccollab`) return true
        if (versions.some((v) => path === `${CACHE}/${marketplace}/cccollab/${v}`)) return true
      }
      return false
    },
  }
}

interface Harness {
  deps: DoctorDeps
  logs: string[]
  removed: string[]
}

function harness(
  overrides: Partial<DoctorDeps> & {
    layout?: Record<string, string[]>
    referenced?: string[]
  } = {},
): Harness {
  const logs: string[] = []
  const removed: string[] = []
  const layout = overrides.layout ?? { kollaborativeai: ['3.5.0'] }
  const referenced = overrides.referenced ?? [`${CACHE}/kollaborativeai/cccollab/3.5.0`]
  const fs = tree(layout)

  const deps: DoctorDeps = {
    ...fs,
    readFile(path) {
      if (path === `${HOME}/.claude/plugins/installed_plugins.json`) {
        return JSON.stringify({ plugins: { 'cccollab@kollaborativeai': referenced.map((p) => ({ installPath: p })) } })
      }
      const match = /cccollab\/([^/]+)\/\.claude-plugin\/plugin\.json$/.exec(path)
      return match ? `{"version": "${match[1]}"}` : undefined
    },
    fileExists: () => true,
    removeDir: (path) => removed.push(path),
    processDump: () => '',
    listBinariesOnPath: () => [{ path: '/opt/homebrew/bin/cccollab', version: '3.5.0' }],
    confirm: async () => true,
    log: (m) => logs.push(m),
    homeDir: HOME,
    serverVersion: '3.5.0',
    binaryPath: '/opt/homebrew/bin/cccollab',
    env: {},
    ...overrides,
  }
  return { deps, logs, removed }
}

describe('parseDoctorArgs', () => {
  it('reports only by default — pruning is never implied', () => {
    expect(parseDoctorArgs([])).toEqual({ prune: false, yes: false })
  })

  it('accepts --prune and --yes', () => {
    expect(parseDoctorArgs(['--prune'])).toEqual({ prune: true, yes: false })
    expect(parseDoctorArgs(['--prune', '-y'])).toEqual({ prune: true, yes: true })
  })
})

describe('referencedInstallPaths', () => {
  it('collects every installPath regardless of nesting', () => {
    const raw = JSON.stringify({
      plugins: {
        'cccollab@kollaborativeai': [{ installPath: '/a' }],
        'other@mkt': [{ installPath: '/b' }],
      },
    })
    expect(referencedInstallPaths(raw).sort()).toEqual(['/a', '/b'])
  })

  it('returns nothing for missing or malformed bookkeeping', () => {
    expect(referencedInstallPaths(undefined)).toEqual([])
    expect(referencedInstallPaths('{ not json')).toEqual([])
  })
})

describe('scanCaches', () => {
  // `retired` stands for the marketplace cccollab shipped from before the
  // rebrand. Copies under it survive uninstalling the plugin, which is how a
  // machine ends up serving skills from a marketplace it no longer subscribes to.
  it('finds cccollab copies across every marketplace', () => {
    const { deps } = harness({
      layout: { kollaborativeai: ['3.5.0', '3.4.0'], retired: ['3.1.0'] },
      referenced: [`${CACHE}/kollaborativeai/cccollab/3.5.0`],
    })
    const entries = scanCaches(deps)
    expect(entries.map((e) => `${e.marketplace}/${e.version}`).sort()).toEqual([
      'kollaborativeai/3.4.0',
      'kollaborativeai/3.5.0',
      'retired/3.1.0',
    ])
  })

  it('marks the installed copy as referenced and the rest as not', () => {
    const { deps } = harness({ layout: { kollaborativeai: ['3.5.0', '3.4.0'] } })
    const entries = scanCaches(deps)
    expect(entries.find((e) => e.version === '3.5.0')?.referenced).toBe(true)
    expect(entries.find((e) => e.version === '3.4.0')?.referenced).toBe(false)
  })

  it('marks a copy held by a live session as in use', () => {
    const stale = `${CACHE}/kollaborativeai/cccollab/3.4.0`
    const { deps } = harness({
      layout: { kollaborativeai: ['3.5.0', '3.4.0'] },
      processDump: () => `node /opt/homebrew/bin/cccollab CLAUDE_PLUGIN_ROOT=${stale}`,
    })
    expect(scanCaches(deps).find((e) => e.version === '3.4.0')?.inUse).toBe(true)
  })

  it('ignores marketplaces that ship no cccollab', () => {
    const { deps } = harness({ layout: { kollaborativeai: ['3.5.0'], superpowers: [] } })
    expect(scanCaches(deps)).toHaveLength(1)
  })

  it('returns nothing when there is no plugin cache at all', () => {
    const { deps } = harness({ layout: {} })
    expect(scanCaches(deps)).toEqual([])
  })
})

describe('prunable', () => {
  const entry = (over: Partial<ReturnType<typeof scanCaches>[number]>) => ({
    path: `${CACHE}/m/cccollab/1.0.0`,
    marketplace: 'm',
    version: '1.0.0',
    referenced: false,
    inUse: false,
    ...over,
  })

  it('selects copies that are neither installed nor loaded', () => {
    expect(prunable([entry({})])).toHaveLength(1)
  })

  it('never selects the installed copy', () => {
    expect(prunable([entry({ referenced: true })])).toEqual([])
  })

  it('never selects a copy a live session is running from', () => {
    // The reason this rule exists: pruning by bookkeeping alone deleted the
    // plugin roots of eighteen live sessions on the reporter's machine.
    expect(prunable([entry({ inUse: true })])).toEqual([])
  })
})

describe('runDoctor', () => {
  it('reports a clean machine and succeeds', async () => {
    const { deps, logs } = harness()
    expect(await runDoctor({ prune: false, yes: false }, deps)).toBe(0)
    expect(logs.join('\n')).toContain('3.5.0')
  })

  it('exits non-zero when stale copies exist but pruning was not asked for', async () => {
    const { deps, logs, removed } = harness({ layout: { kollaborativeai: ['3.5.0', '3.4.0'] } })
    expect(await runDoctor({ prune: false, yes: false }, deps)).toBe(1)
    expect(removed).toEqual([])
    expect(logs.join('\n')).toContain('--prune')
  })

  it('removes only the stale copies when pruning', async () => {
    const { deps, removed } = harness({ layout: { kollaborativeai: ['3.5.0', '3.4.0'], retired: ['3.1.0'] } })
    expect(await runDoctor({ prune: true, yes: true }, deps)).toBe(0)
    expect(removed.sort()).toEqual([`${CACHE}/kollaborativeai/cccollab/3.4.0`, `${CACHE}/retired/cccollab/3.1.0`])
  })

  it('leaves an in-use copy alone even when pruning', async () => {
    const held = `${CACHE}/kollaborativeai/cccollab/3.4.0`
    const { deps, removed, logs } = harness({
      layout: { kollaborativeai: ['3.5.0', '3.4.0'] },
      processDump: () => `node /opt/homebrew/bin/cccollab CLAUDE_PLUGIN_ROOT=${held}`,
    })
    await runDoctor({ prune: true, yes: true }, deps)
    expect(removed).toEqual([])
    expect(logs.join('\n')).toContain('in use')
  })

  it('deletes nothing when the user declines', async () => {
    const { deps, removed } = harness({
      layout: { kollaborativeai: ['3.5.0', '3.4.0'] },
      confirm: async () => false,
    })
    expect(await runDoctor({ prune: true, yes: false }, deps)).toBe(1)
    expect(removed).toEqual([])
  })

  it('lists what it will delete before asking', async () => {
    const asked: string[] = []
    const { deps } = harness({
      layout: { kollaborativeai: ['3.5.0', '3.4.0'] },
      confirm: async (q) => {
        asked.push(q)
        return false
      },
    })
    await runDoctor({ prune: true, yes: false }, deps)
    expect(asked).toHaveLength(1)
  })

  it('reports version drift between the binary and the loaded skill', async () => {
    const { deps, logs } = harness({
      env: { CLAUDE_PLUGIN_ROOT: `${CACHE}/kollaborativeai/cccollab/3.4.0` },
      layout: { kollaborativeai: ['3.5.0', '3.4.0'] },
    })
    expect(await runDoctor({ prune: false, yes: false }, deps)).toBe(1)
    expect(logs.join('\n')).toContain('drift')
  })

  it('refuses to remove a path outside the plugin cache', async () => {
    // Defence in depth: bad bookkeeping must never turn into an rm elsewhere.
    const { deps, removed } = harness({
      layout: { kollaborativeai: ['3.5.0'] },
      listDir: (path: string) => (path === CACHE ? ['../../../etc'] : []),
      isDirectory: () => true,
    })
    await runDoctor({ prune: true, yes: true }, deps)
    expect(removed).toEqual([])
  })
})

describe('inspectBinaries', () => {
  it('flags more than one cccollab reachable on PATH', () => {
    // A Homebrew install plus an npm global under a Node version manager is
    // the ordinary way to end up with two. Claude Code runs the first, and
    // nothing tells the session which one it got.
    const { deps } = harness({
      listBinariesOnPath: () => [
        { path: '/opt/homebrew/bin/cccollab', version: '3.5.0' },
        { path: '/Users/dev/.volta/bin/cccollab', version: '3.2.3' },
      ],
    })
    const findings = inspectBinaries(deps)
    expect(findings.shadowed).toBe(true)
    expect(findings.onPath[0]!.path).toBe('/opt/homebrew/bin/cccollab')
  })

  it('does not flag a single install', () => {
    expect(inspectBinaries(harness().deps).shadowed).toBe(false)
  })

  it('spots a session still serving from an uninstalled binary', () => {
    const ghost = '/Users/dev/.volta/tools/image/packages/@kollaborativeai/cccollab/bin/cccollab'
    const { deps } = harness({
      processDump: () => `node ${ghost}\nnode /opt/homebrew/bin/cccollab`,
      fileExists: (path: string) => path !== ghost,
    })
    expect(inspectBinaries(deps).vanished).toEqual([ghost])
  })

  it('reports nothing vanished when every running binary is still on disk', () => {
    const { deps } = harness({ processDump: () => 'node /opt/homebrew/bin/cccollab' })
    expect(inspectBinaries(deps).vanished).toEqual([])
  })
})

describe('runDoctor binary findings', () => {
  it('names the winning binary and exits non-zero when PATH is shadowed', async () => {
    const { deps, logs } = harness({
      listBinariesOnPath: () => [
        { path: '/opt/homebrew/bin/cccollab', version: '3.5.0' },
        { path: '/Users/dev/.volta/bin/cccollab', version: '3.2.3' },
      ],
    })
    expect(await runDoctor({ prune: false, yes: false }, deps)).toBe(1)
    const out = logs.join('\n')
    expect(out).toContain('More than one cccollab is on PATH')
    expect(out).toContain('wins')
    expect(out).toContain('3.2.3')
  })

  it('reports a binary that no longer exists and exits non-zero', async () => {
    const ghost = '/Users/dev/.volta/bin/cccollab'
    const { deps, logs } = harness({
      processDump: () => `node ${ghost}`,
      fileExists: (path: string) => path !== ghost,
    })
    expect(await runDoctor({ prune: false, yes: false }, deps)).toBe(1)
    expect(logs.join('\n')).toContain('no longer')
  })

  it('reports a binary whose version could not be determined', async () => {
    const { deps, logs } = harness({ listBinariesOnPath: () => [{ path: '/usr/local/bin/cccollab' }] })
    await runDoctor({ prune: false, yes: false }, deps)
    expect(logs.join('\n')).toContain('version unknown')
  })
})

describe('resolveOnPath', () => {
  const fs = (executables: string[], links: Record<string, string> = {}) => ({
    isExecutable: (path: string) => executables.includes(path),
    realPath: (path: string) => links[path] ?? path,
  })

  it('returns matches in PATH order', () => {
    const found = resolveOnPath(
      'cccollab',
      '/opt/homebrew/bin:/usr/local/bin',
      fs(['/opt/homebrew/bin/cccollab', '/usr/local/bin/cccollab']),
    )
    expect(found).toEqual(['/opt/homebrew/bin/cccollab', '/usr/local/bin/cccollab'])
  })

  it('returns nothing when the command is not on PATH', () => {
    expect(resolveOnPath('cccollab', '/usr/bin:/bin', fs([]))).toEqual([])
  })

  it('survives an unset or empty PATH', () => {
    expect(resolveOnPath('cccollab', undefined, fs([]))).toEqual([])
    expect(resolveOnPath('cccollab', '', fs([]))).toEqual([])
  })

  it('skips empty PATH segments rather than probing /cccollab', () => {
    expect(resolveOnPath('cccollab', '/usr/bin::/bin', fs(['/cccollab']))).toEqual([])
  })

  it('tolerates trailing slashes on PATH entries', () => {
    expect(resolveOnPath('cccollab', '/opt/bin/', fs(['/opt/bin/cccollab']))).toEqual(['/opt/bin/cccollab'])
  })

  it('counts two PATH entries symlinked to one file as a single install', () => {
    // Otherwise every Homebrew install reads as "shadowed" against its own Cellar path.
    const found = resolveOnPath(
      'cccollab',
      '/opt/homebrew/bin:/opt/homebrew/opt/cccollab/bin',
      fs(['/opt/homebrew/bin/cccollab', '/opt/homebrew/opt/cccollab/bin/cccollab'], {
        '/opt/homebrew/bin/cccollab': '/opt/homebrew/Cellar/cccollab/3.5.0/bin/cccollab',
        '/opt/homebrew/opt/cccollab/bin/cccollab': '/opt/homebrew/Cellar/cccollab/3.5.0/bin/cccollab',
      }),
    )
    expect(found).toEqual(['/opt/homebrew/bin/cccollab'])
  })

  it('keeps genuinely distinct installs apart', () => {
    const found = resolveOnPath(
      'cccollab',
      '/opt/homebrew/bin:/Users/dev/.volta/bin',
      fs(['/opt/homebrew/bin/cccollab', '/Users/dev/.volta/bin/cccollab']),
    )
    expect(found).toHaveLength(2)
  })
})

describe('resolveOnPath across platforms', () => {
  const fs = (executables: string[]) => ({
    isExecutable: (path: string) => executables.includes(path),
    realPath: (path: string) => path,
  })

  it('splits on the separator it is given, not the host platform default', () => {
    const found = resolveOnPath('cccollab', 'C:\\tools;C:\\other', fs(['C:\\tools/cccollab.CMD']), {
      delimiter: ';',
      extensions: ['.COM', '.EXE', '.CMD'],
    })
    expect(found).toEqual(['C:\\tools/cccollab.CMD'])
  })

  it('tries each PATHEXT extension in order', () => {
    const found = resolveOnPath('cccollab', '/tools', fs(['/tools/cccollab.EXE', '/tools/cccollab.CMD']), {
      extensions: ['.COM', '.EXE', '.CMD'],
    })
    expect(found).toEqual(['/tools/cccollab.EXE', '/tools/cccollab.CMD'])
  })

  it('finds nothing when no extension matches, rather than throwing', () => {
    expect(resolveOnPath('cccollab', '/tools', fs(['/tools/cccollab']), { extensions: ['.EXE'] })).toEqual([])
  })
})
