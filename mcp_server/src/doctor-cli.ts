/**
 * Entry point for `cccollab doctor`. Wires the real filesystem, process table
 * and TTY into runDoctor, which is otherwise dependency-injected so the prune
 * rules can be tested without deleting anything.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { parseDoctorArgs, runDoctor, type DoctorDeps } from './doctor.js'
import { extractPluginRoots } from './plugin-version.js'
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
function runningPluginRoots(): string[] {
  const dumps: string[] = []

  if (process.platform === 'linux') {
    try {
      for (const pid of readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        try {
          dumps.push(readFileSync(`/proc/${pid}/environ`, 'utf8'))
        } catch {
          // Process exited, or belongs to another user. Both are expected.
        }
      }
    } catch {
      // No /proc. Fall through to ps.
    }
  }

  if (dumps.length === 0) {
    const result = spawnSync('ps', ['eww', '-A'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (result.stdout) dumps.push(result.stdout)
  }

  return extractPluginRoots(dumps.join('\n')).filter((root) => root.includes('/cccollab/'))
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
  removeDir(path) {
    rmSync(path, { recursive: true, force: true })
  },
  runningPluginRoots,
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
