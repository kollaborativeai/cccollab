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
    // the hosted backend. The location is added so it can be engaged later
    // (join_channel / set_active_channel with location: "remote"), but it
    // carries no `active` flag.
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

  it('fills missing url/clerkIssuer/clerkClientId on a partial default-location entry', () => {
    const result = applyDefaults({
      locations: {
        [DEFAULT_REMOTE_LOCATION_NAME]: { clerkClientId: 'user-supplied-client' },
      },
    })
    const remote = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(remote?.url).toBe(DEFAULT_REMOTE_URL)
    expect(remote?.clerkIssuer).toBe(DEFAULT_CLERK_ISSUER)
    expect(remote?.clerkClientId).toBe('user-supplied-client') // user wins
  })

  it('does not synthesize the default entry if the user already has a different non-local location', () => {
    const result = applyDefaults({
      locations: {
        selfhosted: { url: 'https://my.convex.cloud', clerkIssuer: 'https://my.clerk', clerkClientId: 'my-id' },
      },
    })
    expect(result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]).toBeUndefined()
    expect(result.locations?.selfhosted?.url).toBe('https://my.convex.cloud')
  })

  it('leaves a non-default-named location untouched (no KAI pointer leaks in)', () => {
    // A self-hosted location (any name other than the default) must NOT be
    // back-filled with KAI's production Clerk pointer — otherwise a KAI-minted
    // token would target a foreign host, and the loud "missing clerkIssuer /
    // clerkClientId" validation would never fire. Defaults own only `remote`.
    const result = applyDefaults({
      locations: {
        myremote: { url: 'https://my.convex.cloud' }, // missing clerk pointer
      },
    })
    const remote = result.locations?.myremote
    expect(remote?.url).toBe('https://my.convex.cloud')
    expect(remote?.clerkIssuer).toBeUndefined()
    expect(remote?.clerkClientId).toBeUndefined()
    // and no default `remote` location was synthesized alongside it
    expect(result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]).toBeUndefined()
  })

  it('opts out entirely when CCCOLLAB_NO_DEFAULT_REMOTE is set', () => {
    const result = applyDefaults({ locations: { local: {} } }, { CCCOLLAB_NO_DEFAULT_REMOTE: '1' })
    expect(result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]).toBeUndefined()
  })

  it('opt-out does not back-fill an explicitly declared default entry', () => {
    const result = applyDefaults(
      { locations: { [DEFAULT_REMOTE_LOCATION_NAME]: { url: 'https://my.convex.cloud' } } },
      { CCCOLLAB_NO_DEFAULT_REMOTE: '1' },
    )
    const remote = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(remote?.url).toBe('https://my.convex.cloud')
    expect(remote?.clerkIssuer).toBeUndefined()
    expect(remote?.clerkClientId).toBeUndefined()
  })

  it('empty CCCOLLAB_NO_DEFAULT_REMOTE does not opt out', () => {
    const result = applyDefaults({ locations: { local: {} } }, { CCCOLLAB_NO_DEFAULT_REMOTE: '' })
    expect(result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]).toBeDefined()
  })

  it('leaves credential fields untouched', () => {
    const result = applyDefaults({
      locations: { [DEFAULT_REMOTE_LOCATION_NAME]: { accessToken: 'tok', refreshToken: 'rt' } },
    })
    const remote = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(remote?.accessToken).toBe('tok')
    expect(remote?.refreshToken).toBe('rt')
    // and defaults still filled in for missing fields
    expect(remote?.url).toBe(DEFAULT_REMOTE_URL)
  })

  it('does not collide with an explicitly active location (default stays inactive)', () => {
    const result = applyDefaults({
      locations: { local: { active: true } },
    })
    const remote = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(remote).toBeDefined()
    expect(remote?.url).toBe(DEFAULT_REMOTE_URL)
    expect(remote?.active).toBeUndefined()
  })

  it('does not collide with a cascade-active location (channel.active)', () => {
    const result = applyDefaults({
      locations: {
        local: { channels: { dev: { active: true } } },
      },
    })
    const remote = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(remote).toBeDefined()
    expect(remote?.active).toBeUndefined()
  })

  it('does not collide with a cascade-active location (topic.active)', () => {
    const result = applyDefaults({
      locations: {
        local: { channels: { dev: { topics: { planning: { active: true } } } } },
      },
    })
    const remote = result.locations?.[DEFAULT_REMOTE_LOCATION_NAME]
    expect(remote).toBeDefined()
    expect(remote?.active).toBeUndefined()
  })
})
