/**
 * Real-process harness for the KAI-368 safety-net regression tests. Run in
 * a child process (via tsx) by `tests/process-safety.spawn.test.ts`.
 *
 * It installs the real safety net on the real `process`, then triggers a
 * background failure whose MODE is the first CLI arg:
 *
 *   - `unhandled`: reject a promise with no `.catch`. If the safety net is
 *     wired correctly the process survives, prints SURVIVED, and exits 0.
 *     Without the listener Node would terminate with a non-zero code.
 *   - `uncaught`: throw from a `setImmediate` callback. The safety net's
 *     uncaughtException handler must log and exit(1) rather than resume.
 *
 * This exercises the registration SIDE-EFFECT (merely having the listener
 * changes Node's crash behaviour) that a fake-`on` unit test cannot.
 */
import { installProcessSafetyNet } from '../../src/process-safety.js'

installProcessSafetyNet((msg) => console.error(`[cccollab] ${msg}`))

const mode = process.argv[2]

if (mode === 'unhandled') {
  Promise.reject(new Error('background rejection from harness'))
  // Reached only if the rejection did NOT terminate the process.
  setTimeout(() => {
    console.error('[harness] SURVIVED')
    process.exit(0)
  }, 150)
} else if (mode === 'uncaught') {
  setImmediate(() => {
    throw new Error('uncaught from harness')
  })
  // The uncaughtException handler should exit(1) before this fires; if it
  // ever resumes instead, this exits 0 and the test fails.
  setTimeout(() => {
    console.error('[harness] RESUMED (should not happen)')
    process.exit(0)
  }, 1500)
} else {
  console.error(`[harness] unknown mode: ${mode}`)
  process.exit(2)
}
