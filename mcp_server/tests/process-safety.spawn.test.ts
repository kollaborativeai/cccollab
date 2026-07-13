import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveTsx } from '../src/resolve-tsx.js'

/**
 * Spawn the harness in a REAL child process and capture its exit code +
 * stderr. This is the only test that proves the safety net's registration
 * side-effect actually changes Node's crash behaviour (KAI-368): the
 * fake-`on` unit tests invoke the handlers directly and so cannot catch a
 * regression like `once` instead of `on`, or installing after the first
 * `await`.
 */
function runHarness(mode: 'unhandled' | 'uncaught'): Promise<{ code: number | null; stderr: string }> {
  const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
  if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
  const harness = fileURLToPath(new URL('./fixtures/safety-net-harness.ts', import.meta.url))
  const child = spawn(process.execPath, [tsxCli, harness, mode], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString()
  })
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stderr }))
  })
}

describe('process safety net (real child process)', () => {
  it('a background unhandled rejection does NOT crash the process (exit 0)', async () => {
    const { code, stderr } = await runHarness('unhandled')
    expect(stderr).toMatch(/Unhandled promise rejection/)
    expect(stderr).toContain('SURVIVED')
    expect(code).toBe(0)
  }, 15_000)

  it('an uncaught exception logs and exits(1) instead of resuming', async () => {
    const { code, stderr } = await runHarness('uncaught')
    expect(stderr).toMatch(/Uncaught exception/)
    expect(stderr).not.toContain('RESUMED')
    expect(code).toBe(1)
  }, 15_000)
})
