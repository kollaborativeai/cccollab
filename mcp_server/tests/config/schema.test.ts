import { describe, it, expect, test } from 'vitest'
import { CccollabConfigSchema, LocationConfigSchema, UserLocationConfigSchema } from '../../src/config/schema.js'

describe('CccollabConfigSchema', () => {
  it('accepts an empty object', () => {
    const parsed = CccollabConfigSchema.parse({})
    expect(parsed).toEqual({})
  })

  it('accepts a minimal config with a local location', () => {
    const input = {
      locations: {
        local: {
          active: true,
          channels: { 'team-standup': { active: true } },
        },
      },
    }
    const parsed = CccollabConfigSchema.parse(input)
    expect(parsed).toEqual(input)
  })

  it('accepts a non-local location with url + auth fields', () => {
    const parsed = CccollabConfigSchema.parse({
      locations: {
        acme: {
          url: 'https://example-deployment-123.convex.cloud',
          active: true,
          accessToken: 'jwt-abc',
          refreshToken: 'refresh-xyz',
          userEmail: 'stefan@cccollab.dev',
          userId: 'abc123',
          updatedAt: 1_700_000_000_000,
          channels: {
            'cccollab-dev': {
              active: true,
              topics: { 'ccc-3-testing': { active: true } },
            },
          },
        },
      },
    })
    expect(parsed.locations?.acme?.url).toBe('https://example-deployment-123.convex.cloud')
    expect(parsed.locations?.acme?.channels?.['cccollab-dev']?.topics?.['ccc-3-testing']?.active).toBe(true)
  })

  it('accepts top-level name and objective', () => {
    const parsed = CccollabConfigSchema.parse({
      name: 'cccollab maintainer',
      objective: 'Keep the lights on',
    })
    expect(parsed.name).toBe('cccollab maintainer')
    expect(parsed.objective).toBe('Keep the lights on')
  })

  it('rejects non-record locations', () => {
    expect(() => CccollabConfigSchema.parse({ locations: [] })).toThrow()
    expect(() => CccollabConfigSchema.parse({ locations: 'nope' })).toThrow()
  })

  it('rejects channel.active that is not a boolean', () => {
    expect(() =>
      CccollabConfigSchema.parse({
        locations: { local: { channels: { dev: { active: 'yes' } } } },
      }),
    ).toThrow()
  })

  it('rejects location.url that is not a string', () => {
    expect(() =>
      CccollabConfigSchema.parse({
        locations: { acme: { url: 123 } },
      }),
    ).toThrow()
  })

  it('allows missing url on local location', () => {
    const parsed = CccollabConfigSchema.parse({
      locations: { local: { active: true } },
    })
    expect(parsed.locations?.local?.url).toBeUndefined()
  })

  it('accepts nested topics without active flags', () => {
    const parsed = CccollabConfigSchema.parse({
      locations: { local: { channels: { dev: { topics: { planning: {} } } } } },
    })
    expect(parsed.locations?.local?.channels?.dev?.topics?.planning).toEqual({})
  })
})

describe('LocationConfigSchema', () => {
  test('accepts clerk location with the full app pointer', () => {
    const result = LocationConfigSchema.safeParse({
      authType: 'clerk',
      url: 'https://x.convex.cloud',
      clerkIssuer: 'https://x.clerk.accounts.dev',
      clerkClientId: 'cccollab-cli',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a credential-only user-level entry (no app pointer)', () => {
    // saveLocationAuth writes credentials without the project-level
    // clerkIssuer / clerkClientId — the schema must round-trip those
    // entries cleanly. The "Clerk app pointer is configured" check
    // lives at use-site (defaultTransportFactory / handleAuthenticate),
    // not in the parse layer.
    const result = LocationConfigSchema.safeParse({
      authType: 'clerk',
      url: 'https://x.convex.cloud',
      accessToken: 'tok',
      refreshToken: 'rt',
      accessTokenExpiresAt: 1_700_000_000_000,
    })
    expect(result.success).toBe(true)
  })

  test('rejects authType values other than "clerk"', () => {
    const result = LocationConfigSchema.safeParse({
      authType: 'convex-google',
      url: 'https://x.convex.cloud',
    })
    expect(result.success).toBe(false)
  })

  it('rejects clerk location with unknown extra field (.strict)', () => {
    const result = LocationConfigSchema.safeParse({
      authType: 'clerk',
      url: 'https://x.convex.cloud',
      clerkIssuer: 'https://x.clerk.accounts.dev',
      clerkClientId: 'cccollab-cli',
      randomUnknownField: 'should-be-rejected',
    })
    expect(result.success).toBe(false)
  })

  it('accepts clerk location with clerkRedirectPort', () => {
    const result = LocationConfigSchema.safeParse({
      authType: 'clerk',
      url: 'https://x.convex.cloud',
      clerkIssuer: 'https://x.clerk.accounts.dev',
      clerkClientId: 'cccollab-cli',
      clerkRedirectPort: 54321,
    })
    expect(result.success).toBe(true)
  })

  it('rejects clerk location with non-integer clerkRedirectPort', () => {
    const result = LocationConfigSchema.safeParse({
      authType: 'clerk',
      url: 'https://x.convex.cloud',
      clerkIssuer: 'https://x.clerk.accounts.dev',
      clerkClientId: 'cccollab-cli',
      clerkRedirectPort: 54321.5,
    })
    expect(result.success).toBe(false)
  })
})

describe('UserLocationConfigSchema (cross-version skew tolerance)', () => {
  it('accepts AND preserves an unknown field (.passthrough) so a newer version can add a credential field without bricking this one', () => {
    const result = UserLocationConfigSchema.safeParse({
      authType: 'clerk',
      url: 'https://x.convex.cloud',
      idToken: 'jwt',
      // A field a future cccollab version might persist that this version
      // doesn't model yet. The user-level (shared ~/.cccollab/config.json)
      // schema must not reject it — and must round-trip it on save.
      futureCredentialField: 'keep-me',
    })
    expect(result.success).toBe(true)
    expect(result.success && (result.data as Record<string, unknown>).futureCredentialField).toBe('keep-me')
  })
})
