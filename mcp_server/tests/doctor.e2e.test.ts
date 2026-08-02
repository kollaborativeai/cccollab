import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * End-to-end coverage for `cccollab doctor`: the real launcher, the real
 * filesystem, the real process table, a real PATH.
 *
 * The unit tests inject every dependency, which is what let a broken PATH probe
 * ship green — `command -v -a` is rejected by bash's builtin, so the shell form
 * failed silently and reported no cccollab installed on a machine that had one.
 * Injected data cannot catch that; only running the thing can. Everything here
 * is scoped to a temporary HOME and a two-entry PATH so it neither reads nor
 * touches the developer's real install.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const LAUNCHER = join(REPO, 'bin', 'cccollab.mjs')

let home: string
let binDir: string

/** A stand-in cccollab on PATH that answers `--version` and nothing else. */
function fakeBinary(name: string, version: string): string {
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}"\nexit 0\n`)
  chmodSync(path, 0o755)
  return path
}

function cachedPlugin(marketplace: string, version: string): string {
  const path = join(home, '.claude', 'plugins', 'cache', marketplace, 'cccollab', version)
  mkdirSync(join(path, '.claude-plugin'), { recursive: true })
  writeFileSync(join(path, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cccollab', version }))
  mkdirSync(join(path, 'skills', 'cccollab'), { recursive: true })
  writeFileSync(join(path, 'skills', 'cccollab', 'SKILL.md'), '# cccollab\n')
  return path
}

function markInstalled(...paths: string[]): void {
  const file = join(home, '.claude', 'plugins', 'installed_plugins.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      plugins: { 'cccollab@kollaborativeai': paths.map((p) => ({ installPath: p, version: '3.5.0' })) },
    }),
  )
}

function runDoctor(args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [LAUNCHER, 'doctor', ...args], {
    encoding: 'utf8',
    // A deliberately minimal PATH: the fake binaries plus the system
    // directories `ps` lives in. Nothing here can see the real install.
    env: { HOME: home, PATH: `${binDir}:/usr/bin:/bin`, ...env },
    timeout: 60_000,
  })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cccollab-doctor-home-'))
  binDir = mkdtempSync(join(tmpdir(), 'cccollab-doctor-bin-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
})

describe('cccollab doctor end to end', () => {
  it('finds a cccollab that is genuinely on PATH and reports its version', () => {
    // The regression test for the shell-based probe: this asserts against a real
    // PATH lookup, so a probe that silently returns nothing fails here.
    fakeBinary('cccollab', '9.9.9')
    const { out } = runDoctor()
    expect(out).toContain('on PATH:')
    expect(out).toContain(binDir)
    expect(out).toContain('9.9.9')
    expect(out).not.toContain('no cccollab found on PATH')
  })

  // HOME and PATH are sandboxed here, but the process table is not — it is
  // machine-wide, so a developer running this with a stale cccollab session
  // open legitimately gets a finding and exit 1. Cases whose subject is the
  // *absence* of a problem therefore assert on the specific line rather than
  // the aggregate exit code; exit-code semantics are covered by the unit tests,
  // where the process dump is injected.
  it('reports nothing to clean up when every cached copy is installed', () => {
    fakeBinary('cccollab', '9.9.9')
    markInstalled(cachedPlugin('kollaborativeai', '3.5.0'))
    const { out } = runDoctor()
    expect(out).toContain('No stale copies. Nothing to clean up.')
    expect(out).not.toContain('could be removed')
  })

  it('lists cached copies and exits non-zero when one is unused', () => {
    fakeBinary('cccollab', '9.9.9')
    markInstalled(cachedPlugin('kollaborativeai', '3.5.0'))
    cachedPlugin('kollaborativeai', '3.4.0')
    const { code, out } = runDoctor()
    expect(code).toBe(1)
    expect(out).toContain('kollaborativeai/3.4.0')
    expect(out).toContain('--prune')
  })

  it('deletes only the unused copy when pruning, and leaves other plugins alone', () => {
    fakeBinary('cccollab', '9.9.9')
    const installed = cachedPlugin('kollaborativeai', '3.5.0')
    const stale = cachedPlugin('retired', '3.1.0')
    markInstalled(installed)
    const bystander = join(home, '.claude', 'plugins', 'cache', 'superpowers', 'superpowers', '1.0.0')
    mkdirSync(bystander, { recursive: true })

    expect(runDoctor(['--prune', '--yes']).out).toContain('Removed retired/3.1.0')

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(installed)).toBe(true)
    expect(existsSync(bystander)).toBe(true)
  })

  it('deletes nothing when --prune is given without a TTY to confirm at', () => {
    // spawnSync gives the child a pipe, not a TTY. Silence must never be
    // read as consent to delete.
    fakeBinary('cccollab', '9.9.9')
    markInstalled(cachedPlugin('kollaborativeai', '3.5.0'))
    const stale = cachedPlugin('retired', '3.1.0')

    expect(runDoctor(['--prune']).code).toBe(1)
    expect(existsSync(stale)).toBe(true)
  })

  it('warns about drift when spawned against a plugin of a different version', () => {
    fakeBinary('cccollab', '9.9.9')
    const root = cachedPlugin('kollaborativeai', '0.0.1-old')
    markInstalled(root)
    const { code, out } = runDoctor([], { CLAUDE_PLUGIN_ROOT: root })
    expect(out).toContain('version drift')
    expect(out).toContain('0.0.1-old')
    expect(code).toBe(1)
  })

  it('warns when the plugin root it was spawned against has been deleted', () => {
    fakeBinary('cccollab', '9.9.9')
    const { code, out } = runDoctor([], { CLAUDE_PLUGIN_ROOT: join(home, 'gone', 'cccollab', '3.4.0') })
    expect(out).toContain('cannot be read')
    expect(code).toBe(1)
  })

  it('reports two installs on PATH and names the one that wins', () => {
    const first = fakeBinary('cccollab', '9.9.9')
    const second = mkdtempSync(join(tmpdir(), 'cccollab-doctor-bin2-'))
    try {
      writeFileSync(join(second, 'cccollab'), '#!/bin/sh\n[ "$1" = "--version" ] && echo "1.0.0"\nexit 0\n')
      chmodSync(join(second, 'cccollab'), 0o755)
      const result = spawnSync(process.execPath, [LAUNCHER, 'doctor'], {
        encoding: 'utf8',
        env: { HOME: home, PATH: `${binDir}:${second}:/usr/bin:/bin` },
        timeout: 60_000,
      })
      const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
      expect(out).toContain('More than one cccollab is on PATH')
      expect(out).toContain(first)
      expect(out).toContain('1.0.0')
      expect(result.status).toBe(1)
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })
})

let bootCounter = 0

describe('the stdio server on startup', () => {
  /**
   * Boots the real MCP server the way Claude Code does — bare `cccollab` over
   * stdio — and returns whatever it wrote to stderr before shutting down.
   *
   * Starting the server starts a broker, and the broker outlives the server it
   * was spawned by. Everything is therefore pinned to a throwaway HOME: the run
   * directory derives from `homedir()`, so a temp HOME keeps the rendezvous, pid
   * file and logs out of the developer's real `~/.cccollab`. The broker is then
   * reaped by pid from the rendezvous it wrote — killing the server alone leaves
   * it running.
   */
  async function bootAndReadStderr(pluginRoot: string): Promise<string> {
    const sandboxHome = mkdtempSync(join(tmpdir(), 'cccollab-boot-home-'))
    const profile = `drifttest-${process.pid}-${bootCounter++}`
    const child = spawn(process.execPath, [LAUNCHER], {
      env: { ...process.env, HOME: sandboxHome, CCCOLLAB_PROFILE: profile, CLAUDE_PLUGIN_ROOT: pluginRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    try {
      await new Promise<void>((resolve) => {
        // The warning is printed during startup, so resolve as soon as the
        // server says anything; the timeout is the floor for the silent case.
        const timer = setInterval(() => {
          if (stderr.includes('[cccollab]')) {
            clearInterval(timer)
            resolve()
          }
        }, 50)
        setTimeout(() => {
          clearInterval(timer)
          resolve()
        }, 8000)
      })
    } finally {
      child.kill('SIGTERM')
      reapBroker(sandboxHome, profile)
      rmSync(sandboxHome, { recursive: true, force: true })
    }
    return stderr
  }

  /** Kill the broker the booted server left behind, by the pid it published. */
  function reapBroker(sandboxHome: string, profile: string): void {
    const rendezvous = join(sandboxHome, '.cccollab', 'run', `${profile}.json`)
    try {
      const { pid } = JSON.parse(readFileSync(rendezvous, 'utf8')) as { pid?: number }
      if (typeof pid === 'number') process.kill(pid, 'SIGTERM')
    } catch {
      // No rendezvous, unparseable, or already gone. Nothing to reap.
    }
  }

  it('warns on stderr when the plugin that spawned it is a different version', async () => {
    // The one path no unit test reaches: the real binary, its real package
    // version, and a real CLAUDE_PLUGIN_ROOT handed to it by its parent.
    const root = mkdtempSync(join(tmpdir(), 'cccollab-drift-root-'))
    try {
      mkdirSync(join(root, '.claude-plugin'), { recursive: true })
      writeFileSync(
        join(root, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'cccollab', version: '0.0.1-old' }),
      )
      const stderr = await bootAndReadStderr(root)
      expect(stderr).toContain('version drift')
      expect(stderr).toContain('0.0.1-old')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it('says nothing about versions when the plugin matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cccollab-aligned-root-'))
    try {
      const version = spawnSync(process.execPath, [LAUNCHER, '--version'], { encoding: 'utf8' }).stdout.trim()
      mkdirSync(join(root, '.claude-plugin'), { recursive: true })
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cccollab', version }))
      const stderr = await bootAndReadStderr(root)
      expect(stderr).not.toContain('version drift')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('launcher dispatch', () => {
  it('keeps printing a version for the launcher itself', () => {
    // `brew test` runs this on every install; it must stay offline and cheap.
    const result = spawnSync(process.execPath, [LAUNCHER, '--version'], { encoding: 'utf8', timeout: 30_000 })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
