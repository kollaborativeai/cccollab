import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

/**
 * The guard above is only half the contract. The other half is that the shipped
 * `bin/cccollab.mjs` must actually satisfy it — and nothing tested that.
 *
 * The tests in the first describe hand `isProcessEntrypoint` two hand-written
 * argv strings. That validates the function and never the launcher-to-module
 * wiring, which is exactly how this shipped broken: `package.json#files` omits
 * `src/`, so an installed copy has only `bin/` and `dist/`. The launcher's
 * dist branches did `await import(distEntry)` — a SAME-process import, where
 * `argv[1]` stays `bin/cccollab.mjs` while `import.meta.url` is
 * `dist/server.js`. Those can never be equal, so the guard was false, `main()`
 * never ran, and `cccollab` exited 0 with no output and no MCP tools.
 *
 * These tests therefore run the REAL launcher, copied at test time so it cannot
 * drift from the shipped one, against a package laid out the way npm installs
 * it. The dist stand-in records the `argv[1]` the real server would test its
 * guard against, and the assertion feeds that to the REAL `isProcessEntrypoint`
 * rather than to a re-implementation that could drift away from it.
 */
describe('the installed launcher and the entrypoint guard', { timeout: 60_000 }, () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
  const REAL_LAUNCHER = join(REPO, 'bin', 'cccollab.mjs')

  /** Records argv[1] on load, so the assertion can apply the production guard to it. */
  const DIST_ENTRY = [
    "import { writeFileSync } from 'node:fs'",
    'writeFileSync(process.env.CCCOLLAB_TEST_DIST_RECORD, process.argv[1] ?? "")',
    '',
  ].join('\n')

  /**
   * Lays out a package the way `npm install` does: the real launcher in `bin/`,
   * a built entry in `dist/`, and no `node_modules`. `src/` is created only when
   * asked, because its absence is what selects the installed dispatch branch.
   */
  function stageInstalledPackage(options: { withSrc?: boolean; distBody?: string } = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'cccollab-installed-'))
    mkdirSync(join(root, 'bin'))
    mkdirSync(join(root, 'dist'))
    // Copied rather than referenced in place: an in-place run would find the
    // repo's own src/ and node_modules and take the dev branch instead.
    copyFileSync(REAL_LAUNCHER, join(root, 'bin', 'cccollab.mjs'))
    // `type: module` mirrors the published manifest. Without it Node parses
    // dist/*.js as CommonJS and `import.meta` is a syntax error.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'cccollab-installed-fixture', version: '0.0.0', type: 'module', bin: 'bin/cccollab.mjs' }),
    )
    writeFileSync(join(root, 'dist', 'server.js'), options.distBody ?? DIST_ENTRY)
    if (options.withSrc) {
      mkdirSync(join(root, 'src'))
      // Marks the dev branch having been taken. It must stay unwritten: if tsx
      // were resolvable from the temp dir this file would run instead of dist/,
      // and the test would be measuring the branch it is not about.
      writeFileSync(
        join(root, 'src', 'server.ts'),
        [
          "import { writeFileSync } from 'node:fs'",
          'writeFileSync(process.env.CCCOLLAB_TEST_SRC_RECORD, "src")',
          '',
        ].join('\n'),
      )
    }
    return root
  }

  /** Runs the staged launcher exactly as a user's shell would: `node bin/cccollab.mjs`. */
  function runLauncher(root: string): Promise<number | null> {
    const child = spawn(process.execPath, [join(root, 'bin', 'cccollab.mjs')], {
      // HOME points into the sandbox so a globally installed tsx in the
      // developer's home cannot be resolved and quietly select the dev branch.
      env: {
        ...process.env,
        HOME: root,
        CCCOLLAB_TEST_DIST_RECORD: join(root, 'dist-argv1'),
        CCCOLLAB_TEST_SRC_RECORD: join(root, 'src-ran'),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('the launcher never exited'))
      }, 30_000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  /** Asserts the server module was loaded AS the process entrypoint, by the real guard. */
  function expectMainWouldRun(root: string): void {
    const record = join(root, 'dist-argv1')
    expect(existsSync(record), 'dist/server.js was never loaded at all').toBe(true)
    const argv1 = readFileSync(record, 'utf8')
    const distUrl = pathToFileURL(join(root, 'dist', 'server.js')).href
    // The production guard, not a copy of it: main() runs iff this is true.
    expect(
      isProcessEntrypoint(distUrl, argv1),
      `main() was gated out: dist/server.js saw argv[1]=${argv1}, so the guard compared it against ${distUrl} and lost`,
    ).toBe(true)
  }

  it('runs main() when launched through the installed bin (no src/, dist only)', async () => {
    const root = stageInstalledPackage()
    try {
      await runLauncher(root)
      expectMainWouldRun(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs main() when src/ is present but tsx is not installed, falling back to dist', async () => {
    const root = stageInstalledPackage({ withSrc: true })
    try {
      await runLauncher(root)
      // Falsifies the instrument: if tsx were resolvable here the dev branch
      // would have run and this test would prove nothing about the dist branch.
      expect(existsSync(join(root, 'src-ran')), 'tsx resolved from the sandbox, so the dist fallback never ran').toBe(
        false,
      )
      expectMainWouldRun(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('forwards the exit code of the installed dist entry', async () => {
    // Dispatching to a child is only correct if the child's exit code still
    // reaches the caller: `cccollab doctor` reports findings that way, and a
    // spawn whose code is dropped would report success for every failure.
    const root = stageInstalledPackage({ distBody: `${DIST_ENTRY}process.exit(3)\n` })
    try {
      expect(await runLauncher(root)).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
