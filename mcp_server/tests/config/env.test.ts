import { describe, it, expect } from 'vitest'
import { applyEnvOverrides } from '../../src/config/env.js'
import type { CccollabConfig } from '../../src/config/schema.js'

describe('applyEnvOverrides', () => {
  it('leaves the config unchanged when no env vars are set', () => {
    const config: CccollabConfig = { locations: { local: { active: true } } }
    const result = applyEnvOverrides(config, {})
    expect(result).toEqual(config)
    // Does not mutate the input.
    expect(config.locations?.local?.active).toBe(true)
  })

  it('registers a "remote" location when CCCOLLAB_REMOTE_URL is set and no such location exists', () => {
    const result = applyEnvOverrides({}, { CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud' })
    expect(result.locations?.remote?.url).toBe('https://env.convex.cloud')
    expect(result.locations?.remote?.active).toBe(true)
  })

  it('updates an existing "remote" location rather than creating a duplicate', () => {
    const result = applyEnvOverrides(
      {
        locations: {
          remote: {
            url: 'https://file.convex.cloud',
            accessToken: 'file-token',
            refreshToken: 'file-refresh',
            userEmail: 'stefan@flatout.solutions',
          },
        },
      },
      { CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud' },
    )
    expect(result.locations?.remote?.url).toBe('https://env.convex.cloud')
    // Existing auth fields are preserved.
    expect(result.locations?.remote?.accessToken).toBe('file-token')
    expect(result.locations?.remote?.userEmail).toBe('stefan@flatout.solutions')
  })

  it("clears other locations' active flag when CCCOLLAB_REMOTE_URL is set", () => {
    const result = applyEnvOverrides(
      {
        locations: {
          local: { active: true },
          flatout: { url: 'https://a.convex.cloud', active: true },
        },
      },
      { CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud' },
    )
    expect(result.locations?.local?.active).toBeUndefined()
    expect(result.locations?.flatout?.active).toBeUndefined()
    expect(result.locations?.remote?.active).toBe(true)
  })

  it('clears nested channel active flags so the cascade does not re-promote a non-env location', () => {
    // Regression: project config flags `local` AND a channel inside it
    // as active. The env-override sweep used to clear only the
    // location-level `active`, leaving `channels.<name>.active` intact;
    // the cascade in active.ts then re-promoted `local`, producing two
    // active locations and the "exactly one active location required"
    // error at startup.
    const result = applyEnvOverrides(
      {
        locations: {
          local: {
            active: true,
            channels: { cccollab: { active: true } },
          },
        },
      },
      { CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud' },
    )
    expect(result.locations?.local?.active).toBeUndefined()
    expect(result.locations?.local?.channels?.cccollab?.active).toBeUndefined()
    expect(result.locations?.remote?.active).toBe(true)
  })

  it('clears nested topic active flags so the cascade does not re-promote a non-env location', () => {
    // Same regression at the topic layer: a topic with `active: true`
    // also cascades up to its location, so the env-override sweep must
    // clear it too.
    const result = applyEnvOverrides(
      {
        locations: {
          local: {
            channels: {
              cccollab: {
                topics: { 'design-review': { active: true } },
              },
            },
          },
        },
      },
      { CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud' },
    )
    expect(result.locations?.local?.channels?.cccollab?.topics?.['design-review']?.active).toBeUndefined()
    expect(result.locations?.remote?.active).toBe(true)
  })

  it('assigns CCCOLLAB_AUTH_TOKEN to the active non-local location', () => {
    const result = applyEnvOverrides(
      {
        locations: {
          local: {},
          flatout: { url: 'https://a.convex.cloud', active: true },
        },
      },
      { CCCOLLAB_AUTH_TOKEN: 'env-jwt' },
    )
    expect(result.locations?.flatout?.accessToken).toBe('env-jwt')
    expect(result.locations?.local).toBeDefined()
  })

  it('assigns CCCOLLAB_AUTH_TOKEN to the env-registered "remote" location when both env vars are set', () => {
    const result = applyEnvOverrides(
      {},
      {
        CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud',
        CCCOLLAB_AUTH_TOKEN: 'env-jwt',
      },
    )
    expect(result.locations?.remote?.url).toBe('https://env.convex.cloud')
    expect(result.locations?.remote?.accessToken).toBe('env-jwt')
    expect(result.locations?.remote?.active).toBe(true)
  })

  it('ignores empty env var strings', () => {
    const result = applyEnvOverrides({}, { CCCOLLAB_REMOTE_URL: '', CCCOLLAB_AUTH_TOKEN: '' })
    expect(result.locations).toBeUndefined()
  })

  it('assigns CCCOLLAB_AUTH_TOKEN to nothing when no non-local location is active', () => {
    // Defensive: without a target, the token has nowhere to go. Callers
    // that set CCCOLLAB_AUTH_TOKEN without URL or an existing active
    // non-local location see a no-op (not an error). The active-cascade
    // validator will surface "no active location" later if relevant.
    const result = applyEnvOverrides({ locations: { local: { active: true } } }, { CCCOLLAB_AUTH_TOKEN: 'orphan-jwt' })
    expect(result.locations?.local?.accessToken).toBeUndefined()
  })

  it('overrides top-level name via CCCOLLAB_NAME', () => {
    const result = applyEnvOverrides({ name: 'from-file' }, { CCCOLLAB_NAME: 'from-env' })
    expect(result.name).toBe('from-env')
  })

  it('overrides top-level objective via CCCOLLAB_OBJECTIVE', () => {
    const result = applyEnvOverrides({ objective: 'from-file' }, { CCCOLLAB_OBJECTIVE: 'from-env' })
    expect(result.objective).toBe('from-env')
  })

  it('trims whitespace in CCCOLLAB_NAME / CCCOLLAB_OBJECTIVE', () => {
    const result = applyEnvOverrides({}, { CCCOLLAB_NAME: '  architect  ', CCCOLLAB_OBJECTIVE: '\n\tpad\n' })
    expect(result.name).toBe('architect')
    expect(result.objective).toBe('pad')
  })
})
