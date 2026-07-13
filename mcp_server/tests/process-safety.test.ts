import { describe, it, expect, vi } from 'vitest'

import { installProcessSafetyNet, type ProcessSafetyTarget } from '../src/process-safety.js'

/** A fake process target: captures the handlers installProcessSafetyNet
 *  registers, without touching the real `process` (which would collide
 *  with the test runner's own listeners). */
function fakeTarget() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const on = vi.fn((event: 'unhandledRejection' | 'uncaughtException', handler: (...args: unknown[]) => void) => {
    handlers.set(event, handler)
  })
  const exit = vi.fn((_code: number) => {})
  const target: ProcessSafetyTarget = { on, exit }
  return { target, handlers, on, exit }
}

describe('installProcessSafetyNet', () => {
  it('registers unhandledRejection and uncaughtException handlers', () => {
    const { target, handlers } = fakeTarget()
    installProcessSafetyNet(vi.fn(), target)

    expect(handlers.has('unhandledRejection')).toBe(true)
    expect(handlers.has('uncaughtException')).toBe(true)
  })

  it('logs an unhandled rejection and keeps the process alive (no exit)', () => {
    const { target, handlers, exit } = fakeTarget()
    const log = vi.fn()
    installProcessSafetyNet(log, target)

    // Invoking the handler must NOT throw and must NOT exit — that is what
    // keeps local (and every other transport) alive when one remote errors.
    expect(() => handlers.get('unhandledRejection')!(new Error('Server Error'))).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    const msg = String(log.mock.calls[0]?.[0])
    expect(msg).toContain('Server Error')
    expect(msg).toMatch(/unhandled/i)
    expect(exit).not.toHaveBeenCalled()
  })

  it('logs an uncaught exception and exits(1) instead of resuming in an undefined state', () => {
    const { target, handlers, exit } = fakeTarget()
    const log = vi.fn()
    installProcessSafetyNet(log, target)

    handlers.get('uncaughtException')!(new Error('boom'))
    expect(String(log.mock.calls[0]?.[0])).toContain('boom')
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('formats a non-Error rejection reason as a string', () => {
    const { target, handlers } = fakeTarget()
    const log = vi.fn()
    installProcessSafetyNet(log, target)

    handlers.get('unhandledRejection')!('plain string reason')
    expect(String(log.mock.calls[0]?.[0])).toContain('plain string reason')
  })

  it('is idempotent: a second install on the same target does not stack duplicate listeners', () => {
    const { target, on } = fakeTarget()
    installProcessSafetyNet(vi.fn(), target)
    installProcessSafetyNet(vi.fn(), target)

    // Two events registered on the first call; the second call is a no-op.
    expect(on).toHaveBeenCalledTimes(2)
  })
})
