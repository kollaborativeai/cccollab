import { describe, it, expect } from 'vitest'
import { CccollabConfigSchema } from '../../src/config/schema.js'

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
        flatout: {
          url: 'https://wonderful-narwhal-409.convex.cloud',
          active: true,
          accessToken: 'jwt-abc',
          refreshToken: 'refresh-xyz',
          userEmail: 'stefan@flatout.solutions',
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
    expect(parsed.locations?.flatout?.url).toBe('https://wonderful-narwhal-409.convex.cloud')
    expect(parsed.locations?.flatout?.channels?.['cccollab-dev']?.topics?.['ccc-3-testing']?.active).toBe(true)
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
        locations: { flatout: { url: 123 } },
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
