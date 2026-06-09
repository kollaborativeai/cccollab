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

  it('synthesizes the location present-but-inactive (never marks it active)', () => {
    // Activation is deferred: a fresh install must not auto-route messages to
    // the hosted backend. The location is added so `set_active_location kai`
    // works later, but it carries no `active` flag.
    const result = applyDefaults({ locations: { local: {} } })
    expect(result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]?.active).toBeUndefined()
  })

  it('synthesizes the location inactive even when nothing else is configured', () => {
    const result = applyDefaults({})
    expect(result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]?.active).toBeUndefined()
  })

  it('does not mutate the caller', () => {
    const input = { locations: { local: {} } }
    applyDefaults(input)
    expect(input.locations).toEqual({ local: {} })
  })

  it('fills missing url/clerkIssuer/clerkClientId on a partial non-local entry', () => {
    const result = applyDefaults({
      locations: {
        kai: { clerkClientId: 'user-supplied-client' },
      },
    })
    const kai = result.locations?.kai
    expect(kai?.url).toBe(DEFAULT_REMOTE_URL)
    expect(kai?.clerkIssuer).toBe(DEFAULT_CLERK_ISSUER)
    expect(kai?.clerkClientId).toBe('user-supplied-client') // user wins
  })

  it('does not synthesize a kai entry if the user already has a different non-local location', () => {
    const result = applyDefaults({
      locations: {
        selfhosted: { url: 'https://my.convex.cloud', clerkIssuer: 'https://my.clerk', clerkClientId: 'my-id' },
      },
    })
    expect(result.locations?.kai).toBeUndefined()
    expect(result.locations?.selfhosted?.url).toBe('https://my.convex.cloud')
  })

  it('fills partial fields on a non-default-named location too', () => {
    const result = applyDefaults({
      locations: {
        myremote: { url: 'https://my.convex.cloud' }, // missing clerk pointer
      },
    })
    const remote = result.locations?.myremote
    expect(remote?.url).toBe('https://my.convex.cloud')
    expect(remote?.clerkIssuer).toBe(DEFAULT_CLERK_ISSUER)
    expect(remote?.clerkClientId).toBe(DEFAULT_CLERK_CLIENT_ID)
  })

  it('leaves credential fields untouched', () => {
    const result = applyDefaults({
      locations: { kai: { accessToken: 'tok', refreshToken: 'rt' } },
    })
    const kai = result.locations?.kai
    expect(kai?.accessToken).toBe('tok')
    expect(kai?.refreshToken).toBe('rt')
    // and defaults still filled in for missing fields
    expect(kai?.url).toBe(DEFAULT_REMOTE_URL)
  })

  it('does not collide with an explicitly active location (kai stays inactive)', () => {
    const result = applyDefaults({
      locations: { local: { active: true } },
    })
    const kai = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(kai).toBeDefined()
    expect(kai?.url).toBe(DEFAULT_REMOTE_URL)
    expect(kai?.active).toBeUndefined()
  })

  it('does not collide with a cascade-active location (channel.active)', () => {
    const result = applyDefaults({
      locations: {
        local: { channels: { dev: { active: true } } },
      },
    })
    const kai = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(kai).toBeDefined()
    expect(kai?.active).toBeUndefined()
  })

  it('does not collide with a cascade-active location (topic.active)', () => {
    const result = applyDefaults({
      locations: {
        local: { channels: { dev: { topics: { planning: { active: true } } } } },
      },
    })
    const kai = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(kai).toBeDefined()
    expect(kai?.active).toBeUndefined()
  })
})
