import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTsx } from '../src/resolve-tsx.js'
import { isProcessEntrypoint } from '../src/server.js'

/**
 * `server.ts` used to call `main()` unguarded at module scope. That made a bare
 * `import` of it do real work: load config, SPAWN a detached broker daemon,
 * register a session on it, and attach a StdioServerTransport to whatever
 * process did the importing — a vitest worker, for instance. Tests that drive
 * the real tool schemas have to import this module, so the guard is what makes
 * importing it safe. It only ever "worked" because the worker was torn down
 * before the async chain got that far, which is a race, not a guard.
 */
describe('server module entrypoint guard', () => {
  it('recognises the module as the entrypoint only when it IS the process entrypoint', () => {
    expect(isProcessEntrypoint('file:///app/server.js', '/app/server.js')).toBe(true)
    expect(isProcessEntrypoint('file:///app/server.js', '/usr/lib/vitest/worker.js')).toBe(false)
    // No argv[1] at all (e.g. `node --eval`): not an entrypoint run.
    expect(isProcessEntrypoint('file:///app/server.js', undefined)).toBe(false)
  })

  it('does not start a server or spawn a broker when the module is merely imported', async () => {
    const profile = `entrypoint-${process.pid}`
    const rendezvous = join(homedir(), '.cccollab', 'run', `${profile}.json`)
    const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
    const serverPath = fileURLToPath(new URL('../src/server.ts', import.meta.url))

    // A child whose entrypoint is NOT server.ts, and which only imports it.
    const child = spawn(process.execPath, [tsxCli, '--eval', `import(${JSON.stringify(serverPath)})`], {
      env: { ...process.env, CCCOLLAB_PROFILE: profile },
      stdio: 'ignore',
    })

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('importing server.ts did not exit: it started a server'))
        }, 15_000)
        child.on('exit', (code) => {
          clearTimeout(timer)
          resolve(code)
        })
      })

      // A pure import must run to completion and exit cleanly...
      expect(exitCode).toBe(0)
      // ...without having spawned a broker daemon behind our back.
      expect(existsSync(rendezvous)).toBe(false)
    } finally {
      if (!child.killed) child.kill('SIGKILL')
      try {
        unlinkSync(rendezvous)
      } catch {
        /* not created: that is the point */
      }
    }
  }, 20_000)
})
