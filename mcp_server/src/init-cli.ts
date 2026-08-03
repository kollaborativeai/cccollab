/**
 * Entry point for `cccollab init`. Wires the real filesystem, process and TTY
 * into runInit, which is otherwise dependency-injected so it can be tested
 * without touching either.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { parseInitArgs, runInit, type InitDeps } from './init.js'

const deps: InitDeps = {
  run(cmd, args) {
    const result = spawnSync(cmd, args, { encoding: 'utf8' })
    return {
      code: result.status ?? 1,
      stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    }
  },
  which(cmd) {
    // `command -v` is POSIX and does not depend on `which` being installed.
    return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0
  },
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  appendFile(path, text) {
    appendFileSync(path, text)
  },
  fileExists: existsSync,
  async confirm(question) {
    // No TTY (piped installer, CI) means nobody can answer. Decline rather
    // than block forever; --yes is the way to opt in non-interactively.
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
  shell: process.env.SHELL ?? '',
}

const code = await runInit(parseInitArgs(process.argv.slice(3)), deps)
process.exit(code)
