import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Private HOME so the test never touches the real ~/.cccollab.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-resolve-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { resolveConfig } = await import('../../src/config/resolve.js')
const { CCCOLLAB_CONFIG_FILE, CCCOLLAB_HOME } = await import('../../src/constants.js')

function writeUserConfig(content: unknown): void {
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  writeFileSync(CCCOLLAB_CONFIG_FILE, JSON.stringify(content, null, 2))
}

function clearUserConfigFile(): void {
  try {
    writeFileSync(CCCOLLAB_CONFIG_FILE, '{}')
  } catch {
    /* nothing to clear */
  }
}

describe('resolveConfig', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cccollab-resolve-proj-'))
    clearUserConfigFile()
    delete process.env.CCCOLLAB_REMOTE_URL
    delete process.env.CCCOLLAB_AUTH_TOKEN
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(TMP_HOME, { recursive: true, force: true })
  })

  it('always includes the reserved "local" location even when no config mentions it', () => {
    const resolved = resolveConfig(projectRoot, {})
    expect(resolved.locations.map((l) => l.name)).toContain('local')
    const local = resolved.locations.find((l) => l.name === 'local')
    expect(local?.isLocal).toBe(true)
  })

  it('reads a non-local location from the user-level file', () => {
    writeUserConfig({
      locations: {
        flatout: {
          url: 'https://a.convex.cloud',
          accessToken: 'jwt',
          refreshToken: 'ref',
          active: true,
          channels: { dev: { active: true } },
        },
      },
    })
    const resolved = resolveConfig(projectRoot, {})
    const flatout = resolved.locations.find((l) => l.name === 'flatout')
    expect(flatout?.url).toBe('https://a.convex.cloud')
    expect(flatout?.accessToken).toBe('jwt')
    expect(flatout?.channels.map((c) => c.name)).toEqual(['dev'])
    expect(resolved.active.activeLocation).toBe('flatout')
    expect(resolved.active.activeChannel).toEqual({ location: 'flatout', name: 'dev' })
  })

  it('merges project config with user config - project wins on scalars, maps union', () => {
    writeUserConfig({
      locations: {
        flatout: {
          url: 'https://user.convex.cloud',
          accessToken: 'user-jwt',
          refreshToken: 'user-ref',
        },
      },
    })
    writeFileSync(
      join(projectRoot, '.cccollab.json'),
      JSON.stringify({
        locations: {
          local: { active: true, channels: { project: {} } },
          flatout: { channels: { 'from-project': {} } },
        },
      }),
    )
    const resolved = resolveConfig(projectRoot, {})
    expect(resolved.projectFilePath).toMatch(/\.cccollab\.json$/)
    const flatout = resolved.locations.find((l) => l.name === 'flatout')
    expect(flatout?.url).toBe('https://user.convex.cloud')
    expect(flatout?.accessToken).toBe('user-jwt')
    expect(flatout?.channels.map((c) => c.name)).toContain('from-project')
    const local = resolved.locations.find((l) => l.name === 'local')
    expect(local?.channels.map((c) => c.name)).toContain('project')
  })

  it('strips credentials from project-level config and warns', () => {
    const warns: string[] = []
    const originalError = console.error
    console.error = (msg: string) => {
      warns.push(msg)
    }
    try {
      writeUserConfig({}) // user-level file present but empty
      writeFileSync(
        join(projectRoot, '.cccollab.json'),
        JSON.stringify({
          locations: {
            flatout: {
              url: 'https://a.convex.cloud',
              accessToken: 'SECRET',
              refreshToken: 'REFRESH',
              channels: { dev: { active: true } },
            },
          },
        }),
      )
      const resolved = resolveConfig(projectRoot, {})
      const flatout = resolved.locations.find((l) => l.name === 'flatout')
      expect(flatout?.accessToken).toBeUndefined()
      expect(flatout?.refreshToken).toBeUndefined()
      expect(flatout?.channels.map((c) => c.name)).toEqual(['dev'])
      expect(warns.join('\n')).toContain('Credentials in project-level config are ignored')
    } finally {
      console.error = originalError
    }
  })

  it('CCCOLLAB_REMOTE_URL env var registers a "remote" location and sets it active', () => {
    const resolved = resolveConfig(projectRoot, {
      CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud',
    })
    const remote = resolved.locations.find((l) => l.name === 'remote')
    expect(remote?.url).toBe('https://env.convex.cloud')
    expect(resolved.active.activeLocation).toBe('remote')
  })

  it('Clerk env vars attach a complete app pointer to the env-registered remote', () => {
    const resolved = resolveConfig(projectRoot, {
      CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud',
      CCCOLLAB_CLERK_ISSUER: 'https://env.clerk.accounts.dev',
      CCCOLLAB_CLERK_CLIENT_ID: 'cccollab-cli',
    })
    const remote = resolved.locations.find((l) => l.name === 'remote')
    expect(remote?.url).toBe('https://env.convex.cloud')
    expect(remote?.clerkIssuer).toBe('https://env.clerk.accounts.dev')
    expect(remote?.clerkClientId).toBe('cccollab-cli')
    expect(remote?.authType).toBe('clerk')
  })

  it('CCCOLLAB_REMOTE_URL wins over a project file with active local channels (cascade regression)', () => {
    // Regression for "exactly one active location required, found 2:
    // local, remote." A project file declared `local` active with an
    // active channel inside it; the env var was supposed to override
    // the file and make `remote` the sole active location, but the
    // env-override sweep left the channel-level `active: true` intact,
    // and the cascade in active.ts re-promoted `local`.
    writeFileSync(
      join(projectRoot, '.cccollab.json'),
      JSON.stringify({
        locations: {
          local: {
            active: true,
            channels: { cccollab: { active: true } },
          },
        },
      }),
    )
    const resolved = resolveConfig(projectRoot, {
      CCCOLLAB_REMOTE_URL: 'https://env.convex.cloud',
    })
    expect(resolved.active.activeLocation).toBe('remote')
  })

  it('cascades: topic active flag makes its channel and location active', () => {
    writeUserConfig({
      locations: {
        flatout: {
          url: 'https://a.convex.cloud',
          channels: {
            dev: { topics: { planning: { active: true } } },
          },
        },
      },
    })
    const resolved = resolveConfig(projectRoot, {})
    expect(resolved.active.activeLocation).toBe('flatout')
    expect(resolved.active.activeChannel).toEqual({ location: 'flatout', name: 'dev' })
    expect(resolved.active.activeTopic).toEqual({ location: 'flatout', channel: 'dev', name: 'planning' })
  })

  it('exposes topics per channel on resolved locations', () => {
    writeUserConfig({
      locations: {
        flatout: {
          url: 'https://a.convex.cloud',
          channels: { dev: { topics: { a: {}, b: {} } } },
        },
      },
    })
    const resolved = resolveConfig(projectRoot, {})
    const flatout = resolved.locations.find((l) => l.name === 'flatout')
    const dev = flatout?.channels.find((c) => c.name === 'dev')
    expect(dev?.topics.map((t) => t.name).sort()).toEqual(['a', 'b'])
  })

  it('walks up parent directories to find .cccollab.json', () => {
    writeFileSync(join(projectRoot, '.cccollab.json'), JSON.stringify({ locations: { local: { active: true } } }))
    const nested = join(projectRoot, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    const resolved = resolveConfig(nested, {})
    expect(resolved.active.activeLocation).toBe('local')
  })

  it('loads a user config whose clerk location omits clerkIssuer/clerkClientId', () => {
    // saveLocationAuth writes only authType + tokens; the app-pointer fields
    // (clerkIssuer/clerkClientId) are optional in the user-level file — they
    // may be supplied by project config. loadUserConfig must accept this
    // shape, not reject it with the strict project-level schema.
    writeUserConfig({
      locations: {
        remote: {
          url: 'https://x.convex.cloud',
          authType: 'clerk',
          accessToken: 'tok',
          refreshToken: 'rt',
          accessTokenExpiresAt: 1_700_000_000_000,
        },
      },
    })
    const resolved = resolveConfig(projectRoot, {})
    const remote = resolved.locations.find((l) => l.name === 'remote')
    expect(remote?.authType).toBe('clerk')
    expect(remote?.url).toBe('https://x.convex.cloud')
  })

  describe('defaults injection (KAI-316)', () => {
    it('synthesizes the kai remote location when only local is configured', () => {
      // Empty user + empty project: applyDefaults runs between merge and env
      // overrides, producing a kai location wired with the baked-in URL +
      // Clerk pointer.
      const resolved = resolveConfig(projectRoot, {})
      const kai = resolved.locations.find((l) => l.name === 'kai')
      expect(kai?.url).toBe('https://collab.kollaborativeai.com')
      expect(kai?.clerkIssuer).toMatch(/clerk\.accounts\.dev$/)
      expect(kai?.clerkClientId).toBe('cccollab-cli')
    })

    it('still lets CCCOLLAB_REMOTE_URL override the baked-in proxy URL', () => {
      // Env overrides run AFTER defaults injection, so CCCOLLAB_REMOTE_URL
      // continues to win. applyEnvOverrides registers under "remote" (not
      // "kai") and marks it active.
      const resolved = resolveConfig(projectRoot, { CCCOLLAB_REMOTE_URL: 'https://override.example' })
      const remote = resolved.locations.find((l) => l.name === 'remote')
      expect(remote?.url).toBe('https://override.example')
      expect(resolved.active.activeLocation).toBe('remote')
    })
  })
})
