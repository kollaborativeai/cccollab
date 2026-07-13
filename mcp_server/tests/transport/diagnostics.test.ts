import { describe, it, expect } from 'vitest'

import { AttachDiagnostics } from '../../src/transport/diagnostics.js'

describe('AttachDiagnostics', () => {
  it('records a failure and reports it by location', () => {
    const diag = new AttachDiagnostics()
    diag.recordFailure('personal', 'introduce() failed: Server Error')

    expect(diag.get('personal')).toEqual({ location: 'personal', reason: 'introduce() failed: Server Error' })
  })

  it('returns undefined for a location with no recorded failure', () => {
    const diag = new AttachDiagnostics()
    expect(diag.get('personal')).toBeUndefined()
  })

  it('clears a recorded failure (e.g. after a successful attach)', () => {
    const diag = new AttachDiagnostics()
    diag.recordFailure('personal', 'boom')
    diag.clear('personal')

    expect(diag.get('personal')).toBeUndefined()
  })

  it('keeps only the latest failure for a location', () => {
    const diag = new AttachDiagnostics()
    diag.recordFailure('personal', 'first')
    diag.recordFailure('personal', 'second')

    expect(diag.get('personal')?.reason).toBe('second')
    expect(diag.entries()).toHaveLength(1)
  })

  it('lists every recorded failure via entries()', () => {
    const diag = new AttachDiagnostics()
    diag.recordFailure('personal', 'a')
    diag.recordFailure('work', 'b')

    expect(diag.entries()).toEqual([
      { location: 'personal', reason: 'a' },
      { location: 'work', reason: 'b' },
    ])
  })

  it('clear() on an unknown location is a no-op', () => {
    const diag = new AttachDiagnostics()
    expect(() => diag.clear('nope')).not.toThrow()
    expect(diag.entries()).toEqual([])
  })
})
