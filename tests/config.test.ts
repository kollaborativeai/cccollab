import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('returns a config with a non-empty username from the OS user info', () => {
    const config = loadConfig()
    expect(typeof config.username).toBe('string')
    expect(config.username.length).toBeGreaterThan(0)
  })
})
