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

  it('writes the Clerk app pointer to the env-registered "remote" location when all three env vars are set', () => {
    // The full one-liner export flow: URL plus the Clerk app pointer
    // yields a complete remote location that authenticate can sign in
    // against without any on-disk config.
    const result = applyEnvOverrides(
      {},
      {
        CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud',
        CCCOLLAB_CLERK_ISSUER: 'https://x.clerk.accounts.dev',
        CCCOLLAB_CLERK_CLIENT_ID: 'cccollab-cli',
      },
    )
    expect(result.locations?.remote).toMatchObject({
      url: 'https://env.convex.cloud',
      active: true,
      authType: 'clerk',
      clerkIssuer: 'https://x.clerk.accounts.dev',
      clerkClientId: 'cccollab-cli',
    })
  })

  it('writes the Clerk app pointer to the active non-local location when CCCOLLAB_REMOTE_URL is not set', () => {
    const result = applyEnvOverrides(
      {
        locations: {
          local: {},
          flatout: { url: 'https://a.convex.cloud', active: true },
        },
      },
      {
        CCCOLLAB_CLERK_ISSUER: 'https://x.clerk.accounts.dev',
        CCCOLLAB_CLERK_CLIENT_ID: 'cccollab-cli',
      },
    )
    expect(result.locations?.flatout).toMatchObject({
      clerkIssuer: 'https://x.clerk.accounts.dev',
      clerkClientId: 'cccollab-cli',
      authType: 'clerk',
    })
  })

  it('lets CCCOLLAB_CLERK_ISSUER and CCCOLLAB_CLERK_CLIENT_ID land independently', () => {
    // Either env var on its own should be applied. Mostly useful as a
    // partial override where the project-level config already supplies
    // the other field.
    const result = applyEnvOverrides(
      {
        locations: {
          flatout: { url: 'https://a.convex.cloud', clerkClientId: 'file-cid', active: true },
        },
      },
      { CCCOLLAB_CLERK_ISSUER: 'https://override.clerk.accounts.dev' },
    )
    expect(result.locations?.flatout?.clerkIssuer).toBe('https://override.clerk.accounts.dev')
    expect(result.locations?.flatout?.clerkClientId).toBe('file-cid')
  })

  it('ignores empty env var strings', () => {
    const result = applyEnvOverrides(
      {},
      { CCCOLLAB_REMOTE_URL: '', CCCOLLAB_CLERK_ISSUER: '', CCCOLLAB_CLERK_CLIENT_ID: '' },
    )
    expect(result.locations).toBeUndefined()
  })

  it('drops Clerk env vars on the floor when no target location is active', () => {
    // Defensive: without CCCOLLAB_REMOTE_URL and without an existing
    // active non-local location, the Clerk env vars have nowhere to
    // attach. The active-cascade validator surfaces "no active
    // location" downstream if that turns out to matter.
    const result = applyEnvOverrides(
      { locations: { local: { active: true } } },
      { CCCOLLAB_CLERK_ISSUER: 'https://orphan.clerk.accounts.dev' },
    )
    expect(result.locations?.local?.clerkIssuer).toBeUndefined()
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
