import { describe, it, expect } from 'vitest'
import { resolveActive } from '../../src/config/active.js'
import type { CccollabConfig } from '../../src/config/schema.js'

describe('resolveActive - cascade', () => {
  it('returns no active state when nothing is marked active', () => {
    const config: CccollabConfig = { locations: { local: {} } }
    const result = resolveActive(config)
    expect(result.activeLocation).toBeUndefined()
    expect(result.activeChannel).toBeUndefined()
    expect(result.activeTopic).toBeUndefined()
  })

  it('picks the single explicitly active location', () => {
    const config: CccollabConfig = {
      locations: {
        local: { active: true },
        acme: { url: 'https://a.convex.cloud' },
      },
    }
    expect(resolveActive(config).activeLocation).toBe('local')
  })

  it('cascades: active topic implies its channel and location are active', () => {
    const config: CccollabConfig = {
      locations: {
        acme: {
          url: 'https://a.convex.cloud',
          channels: {
            'cccollab-dev': {
              topics: { 'ccc-3': { active: true } },
            },
          },
        },
      },
    }
    const result = resolveActive(config)
    expect(result.activeLocation).toBe('acme')
    expect(result.activeChannel).toEqual({ location: 'acme', name: 'cccollab-dev' })
    expect(result.activeTopic).toEqual({ location: 'acme', channel: 'cccollab-dev', name: 'ccc-3' })
  })

  it('cascades: active channel implies its location is active', () => {
    const config: CccollabConfig = {
      locations: {
        acme: {
          url: 'https://a.convex.cloud',
          channels: { 'cccollab-dev': { active: true } },
        },
      },
    }
    const result = resolveActive(config)
    expect(result.activeLocation).toBe('acme')
    expect(result.activeChannel).toEqual({ location: 'acme', name: 'cccollab-dev' })
    expect(result.activeTopic).toBeUndefined()
  })

  it('explicit active on location wins over an absent cascade from below', () => {
    const config: CccollabConfig = {
      locations: {
        local: { active: true },
        acme: {
          url: 'https://a.convex.cloud',
          // channels present but no active flags anywhere below - no cascade.
          channels: { dev: {} },
        },
      },
    }
    expect(resolveActive(config).activeLocation).toBe('local')
  })
})

describe('resolveActive - errors', () => {
  it('throws when two locations are explicitly active', () => {
    const config: CccollabConfig = {
      locations: {
        local: { active: true },
        acme: { url: 'https://a.convex.cloud', active: true },
      },
    }
    expect(() => resolveActive(config)).toThrow(/exactly one active location/i)
  })

  it('throws when two channels in the same location are explicitly active', () => {
    const config: CccollabConfig = {
      locations: {
        local: {
          active: true,
          channels: { dev: { active: true }, ops: { active: true } },
        },
      },
    }
    expect(() => resolveActive(config)).toThrow(/exactly one active channel/i)
  })

  it('throws when two topics in the same channel are explicitly active', () => {
    const config: CccollabConfig = {
      locations: {
        local: {
          channels: {
            dev: {
              topics: { a: { active: true }, b: { active: true } },
            },
          },
        },
      },
    }
    expect(() => resolveActive(config)).toThrow(/exactly one active topic/i)
  })

  it('throws when an active topic sits in a channel whose location does not exist', () => {
    // Defensive: if we somehow get into a state where a topic has active:true
    // but no parent entry, surface a clear error (not a silent undefined).
    const config: CccollabConfig = {
      locations: {
        local: {
          channels: {
            dev: {
              topics: { a: { active: true }, b: { active: true } },
            },
          },
        },
      },
    }
    expect(() => resolveActive(config)).toThrow()
  })

  it('throws when a non-local location is missing url', () => {
    const config: CccollabConfig = {
      locations: { acme: { active: true } },
    }
    expect(() => resolveActive(config)).toThrow(/url/i)
  })

  it('tolerates the local location missing url', () => {
    const config: CccollabConfig = { locations: { local: { active: true } } }
    expect(() => resolveActive(config)).not.toThrow()
  })

  it('throws when cascaded active locations disagree with an explicit one', () => {
    const config: CccollabConfig = {
      locations: {
        local: { active: true },
        acme: {
          url: 'https://a.convex.cloud',
          channels: { 'cccollab-dev': { active: true } },
        },
      },
    }
    // `local` is explicitly active, and `acme` becomes implicitly
    // active via the channel cascade - that's two active locations.
    expect(() => resolveActive(config)).toThrow(/exactly one active location/i)
  })
})
