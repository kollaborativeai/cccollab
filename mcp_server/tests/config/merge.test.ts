import { describe, it, expect, vi } from 'vitest'
import { mergeConfigs, stripProjectCredentials } from '../../src/config/merge.js'
import type { CccollabConfig } from '../../src/config/schema.js'

describe('stripProjectCredentials', () => {
  it('leaves configs without auth fields untouched and emits no warnings', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const input: CccollabConfig = {
      locations: {
        flatout: {
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
        flatout: {
          url: 'https://x.convex.cloud',
          accessToken: 'jwt-abc',
          refreshToken: 'refresh-xyz',
          userEmail: 'stefan@flatout.solutions',
          userId: 'abc123',
          updatedAt: 1_700_000_000_000,
          channels: { dev: { active: true } },
        },
      },
    }
    const { stripped, warnings } = stripProjectCredentials(input, '/tmp/x/.cccollab.json')
    expect(stripped.locations?.flatout?.accessToken).toBeUndefined()
    expect(stripped.locations?.flatout?.refreshToken).toBeUndefined()
    expect(stripped.locations?.flatout?.userEmail).toBeUndefined()
    expect(stripped.locations?.flatout?.userId).toBeUndefined()
    expect(stripped.locations?.flatout?.updatedAt).toBeUndefined()
    // URL / channels untouched.
    expect(stripped.locations?.flatout?.url).toBe('https://x.convex.cloud')
    expect(stripped.locations?.flatout?.channels?.dev?.active).toBe(true)
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
        flatout: { url: 'https://a.convex.cloud', accessToken: 'a' },
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
      locations: { flatout: { url: 'https://x.convex.cloud', accessToken: 'a' } },
    }
    const snapshot = JSON.parse(JSON.stringify(input)) as CccollabConfig
    stripProjectCredentials(input, '/tmp/x/.cccollab.json')
    expect(input).toEqual(snapshot)
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
        flatout: { url: 'https://a.convex.cloud', accessToken: 'a', refreshToken: 'b' },
      },
    }
    const project: CccollabConfig = {
      locations: {
        local: { active: true },
      },
    }
    const merged = mergeConfigs(user, project)
    expect(merged.locations?.flatout?.url).toBe('https://a.convex.cloud')
    expect(merged.locations?.flatout?.accessToken).toBe('a')
    expect(merged.locations?.local?.active).toBe(true)
  })

  it('project wins on nested scalar fields but preserves unmentioned user fields', () => {
    const user: CccollabConfig = {
      locations: {
        flatout: {
          url: 'https://user.convex.cloud',
          accessToken: 'user-token',
          refreshToken: 'user-refresh',
          userEmail: 'stefan@flatout.solutions',
          userId: 'u-1',
          updatedAt: 1,
        },
      },
    }
    const project: CccollabConfig = {
      locations: {
        flatout: {
          url: 'https://project.convex.cloud',
          channels: { dev: { active: true } },
        },
      },
    }
    const merged = mergeConfigs(user, project)
    expect(merged.locations?.flatout?.url).toBe('https://project.convex.cloud')
    expect(merged.locations?.flatout?.accessToken).toBe('user-token')
    expect(merged.locations?.flatout?.channels?.dev?.active).toBe(true)
  })

  it('unions channels across user and project for the same location', () => {
    const user: CccollabConfig = {
      locations: {
        flatout: { url: 'https://a.convex.cloud', channels: { userOnly: { active: true } } },
      },
    }
    const project: CccollabConfig = {
      locations: {
        flatout: { channels: { projectOnly: { active: true } } },
      },
    }
    const merged = mergeConfigs(user, project)
    expect(merged.locations?.flatout?.channels?.userOnly?.active).toBe(true)
    expect(merged.locations?.flatout?.channels?.projectOnly?.active).toBe(true)
  })

  it('unions topics across user and project for the same channel', () => {
    const user: CccollabConfig = {
      locations: {
        flatout: {
          url: 'https://a.convex.cloud',
          channels: { dev: { topics: { userTopic: { active: true } } } },
        },
      },
    }
    const project: CccollabConfig = {
      locations: {
        flatout: {
          channels: { dev: { topics: { projectTopic: { active: true } } } },
        },
      },
    }
    const merged = mergeConfigs(user, project)
    expect(merged.locations?.flatout?.channels?.dev?.topics?.userTopic?.active).toBe(true)
    expect(merged.locations?.flatout?.channels?.dev?.topics?.projectTopic?.active).toBe(true)
  })
})
