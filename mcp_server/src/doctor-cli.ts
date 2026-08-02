/**
 * Entry point for `cccollab doctor`. Wires the real filesystem, process table
 * and TTY into runDoctor, which is otherwise dependency-injected so the prune
 * rules can be tested without deleting anything.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { parseDoctorArgs, resolveOnPath, runDoctor, type BinaryInstall, type DoctorDeps } from './doctor.js'
import { ownVersion } from './own-version.js'

/**
 * CLAUDE_PLUGIN_ROOT of every live process that has one pointing at a cccollab
 * copy. Reads the whole process table in one go rather than enumerating pids:
 * the question is "is this directory loaded by anything", and a pid list races
 * with sessions starting and stopping while we walk it.
 *
 * Failure here must read as "no information", never as "nothing is in use" —
 * so any error path returns [] and the caller treats an empty result as a
 * reason to keep the safer default rather than as proof of absence.
 */
function processDump(): string {
  const result = spawnSync('ps', ['eww', '-A'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.stdout) return result.stdout

  // BSD-style `ps eww` is unavailable or refused. On Linux the same two facts
  // are in /proc: cmdline for the launcher path, environ for the plugin root.
  if (process.platform === 'linux') {
    const parts: string[] = []
    try {
      for (const pid of readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        for (const file of ['cmdline', 'environ']) {
          try {
            parts.push(readFileSync(`/proc/${pid}/${file}`, 'utf8'))
          } catch {
            // Process exited, or belongs to another user. Both are expected.
          }
        }
      }
    } catch {
      // No /proc either. Report nothing rather than guessing.
    }
    return parts.join('\n')
  }

  return ''
}

/**
 * Every `cccollab` reachable on PATH, each asked its own version. Runs the
 * candidate rather than reading a package.json beside it: the launcher resolves
 * through symlinks and version-manager shims, and what matters is what that
 * command reports when Claude Code runs it.
 */
function listBinariesOnPath(): BinaryInstall[] {
  const paths = resolveOnPath('cccollab', process.env.PATH, {
    isExecutable(path) {
      try {
        accessSync(path, constants.X_OK)
        return statSync(path).isFile()
      } catch {
        return false
      }
    },
    realPath(path) {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    },
  })

  return paths.map((path) => {
    const asked = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    const version = (asked.stdout ?? '').trim()
    return { path, ...(asked.status === 0 && version ? { version } : {}) }
  })
}

const deps: DoctorDeps = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  listDir(path) {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  isDirectory(path) {
    try {
      return existsSync(path) && statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  fileExists(path) {
    return existsSync(path)
  },
  removeDir(path) {
    rmSync(path, { recursive: true, force: true })
  },
  processDump,
  listBinariesOnPath,
  async confirm(question) {
    // No TTY means nobody can answer. Decline rather than block, and never
    // treat silence as consent to delete; --yes is the way to opt in.
    if (!process.stdin.isTTY) return false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return /^y(es)?$/i.test((await rl.question(question)).trim())
    } finally {
      rl.close()
    }
  },
  log(message) {
    process.stdout.write(`${message}\n`)
  },
  homeDir: homedir(),
  serverVersion: ownVersion(),
  binaryPath: process.argv[1] ?? 'cccollab',
  env: process.env,
}

const code = await runDoctor(parseDoctorArgs(process.argv.slice(3)), deps)
process.exit(code)
