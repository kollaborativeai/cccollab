import { describe, it, expect, vi } from 'vitest'

import { installProcessSafetyNet } from '../src/process-safety.js'

/** Capture the handlers a call to installProcessSafetyNet registers,
 *  without touching the real `process` (which would collide with the
 *  test runner's own listeners). */
function fakeOn() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const on = (event: string, handler: (...args: unknown[]) => void) => {
    handlers.set(event, handler)
  }
  return { on, handlers }
}

describe('installProcessSafetyNet', () => {
  it('registers unhandledRejection and uncaughtException handlers', () => {
    const { on, handlers } = fakeOn()
    installProcessSafetyNet(vi.fn(), on)

    expect(handlers.has('unhandledRejection')).toBe(true)
    expect(handlers.has('uncaughtException')).toBe(true)
  })

  it('logs an unhandled rejection instead of letting it crash the process', () => {
    const { on, handlers } = fakeOn()
    const log = vi.fn()
    installProcessSafetyNet(log, on)

    // Invoking the handler must NOT throw — that is what keeps the local
    // broker (and every other transport) alive when one remote errors.
    expect(() => handlers.get('unhandledRejection')!(new Error('Server Error'))).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    const msg = String(log.mock.calls[0]?.[0])
    expect(msg).toContain('Server Error')
    expect(msg).toMatch(/unhandled/i)
  })

  it('logs an uncaught exception without exiting', () => {
    const { on, handlers } = fakeOn()
    const log = vi.fn()
    installProcessSafetyNet(log, on)

    expect(() => handlers.get('uncaughtException')!(new Error('boom'))).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('boom')
  })

  it('formats a non-Error rejection reason as a string', () => {
    const { on, handlers } = fakeOn()
    const log = vi.fn()
    installProcessSafetyNet(log, on)

    handlers.get('unhandledRejection')!('plain string reason')
    expect(String(log.mock.calls[0]?.[0])).toContain('plain string reason')
  })
})
