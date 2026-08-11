import { describe, it, expect, vi } from 'vitest'
import { mergeConfigs, stripProjectCredentials } from '../../src/config/merge.js'
import type { CccollabConfig } from '../../src/config/schema.js'

describe('stripProjectCredentials', () => {
  it('leaves configs without auth fields untouched and emits no warnings', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const input: CccollabConfig = {
      locations: {
        acme: {
          url: 'https://x.convex.cloud',
          channels: { dev: { active: true } },
        },
      },
    }
    const { stripped, warnings } = stripProjectCredentials(input, '.cccollab.json')
    expect(stripped).toEqual(input)
    expect(warnings).toBe(0)
    warn.mockRestore()
  })

  it('removes accessToken / refreshToken / userEmail / userId / updatedAt from each location and warns once per occurrence', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const input: CccollabConfig = {
      locations: {
        acme: {
          url: 'https://x.convex.cloud',
          accessToken: 'jwt-abc',
          refreshToken: 'refresh-xyz',
          userEmail: 'stefan@cccollab.dev',
          userId: 'abc123',
          updatedAt: 1_700_000_000_000,
          channels: { dev: { active: true } },
        },
      },
    }
    const { stripped, warnings } = stripProjectCredentials(input, '/tmp/x/.cccollab.json')
    expect(stripped.locations?.acme?.accessToken).toBeUndefined()
    expect(stripped.locations?.acme?.refreshToken).toBeUndefined()
    expect(stripped.locations?.acme?.userEmail).toBeUndefined()
    expect(stripped.locations?.acme?.userId).toBeUndefined()
    expect(stripped.locations?.acme?.updatedAt).toBeUndefined()
    // URL / channels untouched.
    expect(stripped.locations?.acme?.url).toBe('https://x.convex.cloud')
    expect(stripped.locations?.acme?.channels?.dev?.active).toBe(true)
    // One warning per location containing credentials (not per field).
    expect(warnings).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('Credentials in project-level config are ignored')
    warn.mockRestore()
  })

  it('emits one warning per location containing credentials', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const input: CccollabConfig = {
      locations: {
        acme: { url: 'https://a.convex.cloud', accessToken: 'a' },
        other: { url: 'https://b.convex.cloud', refreshToken: 'b' },
      },
    }
    const { warnings } = stripProjectCredentials(input, '/tmp/x/.cccollab.json')
    expect(warnings).toBe(2)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('does not modify the input object', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const input: CccollabConfig = {
      locations: { acme: { url: 'https://x.convex.cloud', accessToken: 'a' } },
    }
    const snapshot = JSON.parse(JSON.stringify(input)) as CccollabConfig
    stripProjectCredentials(input, '/tmp/x/.cccollab.json')
    expect(input).toEqual(snapshot)
    warn.mockRestore()
  })

  it('strips accessTokenExpiresAt but preserves authType, clerkIssuer, and clerkClientId', () => {
    // accessTokenExpiresAt is a credential field and must be stripped.
    // authType, clerkIssuer, and clerkClientId are configuration (not
    // credentials) and must survive so teams can share the Clerk app
    // pointer via a committed .cccollab.json.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const input: CccollabConfig = {
      locations: {
        kai: {
          authType: 'clerk',
          url: 'https://x.convex.cloud',
          clerkIssuer: 'https://clerk.example.com',
          clerkClientId: 'client-123',
          accessToken: 'tok',
          refreshToken: 'rt',
          accessTokenExpiresAt: 1_700_000_000_000,
        },
      },
    }
    const { stripped, warnings } = stripProjectCredentials(input, '.cccollab.json')

    // Credential fields stripped.
    expect(stripped.locations?.['kai']?.accessToken).toBeUndefined()
    expect(stripped.locations?.['kai']?.refreshToken).toBeUndefined()
    expect(
      (stripped.locations?.['kai'] as Record<string, unknown> | undefined)?.['accessTokenExpiresAt'],
    ).toBeUndefined()

    // Configuration fields preserved.
    expect(stripped.locations?.['kai']?.authType).toBe('clerk')
    expect((stripped.locations?.['kai'] as Record<string, unknown> | undefined)?.['clerkIssuer']).toBe(
      'https://clerk.example.com',
    )
    expect((stripped.locations?.['kai'] as Record<string, unknown> | undefined)?.['clerkClientId']).toBe('client-123')
    expect(stripped.locations?.['kai']?.url).toBe('https://x.convex.cloud')

    // One warning since the location had credential fields.
    expect(warnings).toBe(1)
    warn.mockRestore()
  })
})

describe('mergeConfigs', () => {
  it('merges two empty configs into an empty config', () => {
    expect(mergeConfigs({}, {})).toEqual({})
  })

  it('uses the project value when both define the same scalar field', () => {
    const user: CccollabConfig = { name: 'userName', objective: 'userObj' }
    const project: CccollabConfig = { name: 'projectName' }
    const merged = mergeConfigs(user, project)
    expect(merged.name).toBe('projectName')
    expect(merged.objective).toBe('userObj')
  })

  it('unions locations by key', () => {
    const user: CccollabConfig = {
      locations: {
        acme: { url: 'https://a.convex.cloud', accessToken: 'a', refreshToken: 'b' },
      },
    }
    const project: CccollabConfig = {
      locations: {
        local: { active: true },
      },
    }
    const merged = mergeConfigs(user, project)
    expect(merged.locations?.acme?.url).toBe('https://a.convex.cloud')
    expect(merged.locations?.acme?.accessToken).toBe('a')
    expect(merged.locations?.local?.active).toBe(true)
  })

  it('project wins on nested scalar fields but preserves unmentioned user fields', () => {
    const user: CccollabConfig = {
      locations: {
        acme: {
          url: 'https://user.convex.cloud',
          accessToken: 'user-token',
          refreshToken: 'user-refresh',
          userEmail: 'stefan@cccollab.dev',
          userId: 'u-1',
          updatedAt: 1,
        },
      },
    }
    const project: CccollabConfig = {
      locations: {
        acme: {
          url: 'https://project.convex.cloud',
          channels: { dev: { active: true } },
        },
      },
    }
    const merged = mergeConfigs(user, project)
    expect(merged.locations?.acme?.url).toBe('https://project.convex.cloud')
    expect(merged.locations?.acme?.accessToken).toBe('user-token')
    expect(merged.locations?.acme?.channels?.dev?.active).toBe(true)
  })

  it('unions channels across user and project for the same location', () => {
    const user: CccollabConfig = {
      locations: {
        acme: { url: 'https://a.convex.cloud', channels: { userOnly: { active: true } } },
      },
    }
    const project: CccollabConfig = {
      locations: {
        acme: { channels: { projectOnly: { active: true } } },
      },
    }
    const merged = mergeConfigs(user, project)
    expect(merged.locations?.acme?.channels?.userOnly?.active).toBe(true)
    expect(merged.locations?.acme?.channels?.projectOnly?.active).toBe(true)
  })

  it('unions topics across user and project for the same channel', () => {
    const user: CccollabConfig = {
      locations: {
        acme: {
          url: 'https://a.convex.cloud',
          channels: { dev: { topics: { userTopic: { active: true } } } },
        },
      },
    }
    const project: CccollabConfig = {
      locations: {
        acme: {
          channels: { dev: { topics: { projectTopic: { active: true } } } },
        },
      },
    }
    const merged = mergeConfigs(user, project)
    expect(merged.locations?.acme?.channels?.dev?.topics?.userTopic?.active).toBe(true)
    expect(merged.locations?.acme?.channels?.dev?.topics?.projectTopic?.active).toBe(true)
  })
})
