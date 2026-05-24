import { describe, it, expect } from 'vitest'
import { applyDefaults } from '../../src/config/defaults.js'
import {
  DEFAULT_CLERK_CLIENT_ID,
  DEFAULT_CLERK_ISSUER,
  DEFAULT_REMOTE_LOCATION_NAME,
  DEFAULT_REMOTE_URL,
} from '../../src/constants.js'

describe('applyDefaults', () => {
  it('synthesizes the default remote location when only local (or nothing) is configured', () => {
    const result = applyDefaults({ locations: { local: {} } })
    const remote = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(remote).toBeDefined()
    expect(remote?.url).toBe(DEFAULT_REMOTE_URL)
    expect(remote?.clerkIssuer).toBe(DEFAULT_CLERK_ISSUER)
    expect(remote?.clerkClientId).toBe(DEFAULT_CLERK_CLIENT_ID)
    expect(remote?.authType).toBe('clerk')
  })

  it('marks the synthesized location active when no other location is active', () => {
    const result = applyDefaults({ locations: { local: {} } })
    expect(result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]?.active).toBe(true)
  })

  it('does not mutate the caller', () => {
    const input = { locations: { local: {} } }
    applyDefaults(input)
    expect(input.locations).toEqual({ local: {} })
  })
})
