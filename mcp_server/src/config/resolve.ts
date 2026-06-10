import { resolveActive, type ResolvedActive } from './active.js'
import { applyDefaults } from './defaults.js'
import { applyEnvOverrides } from './env.js'
import { loadProjectConfig, loadUserConfig } from './load.js'
import { mergeConfigs, stripProjectCredentials } from './merge.js'
import { LOCAL_LOCATION, type UserCccollabConfig, type UserLocationConfig } from './schema.js'

/**
 * Fully-resolved configuration handed to `server.ts` at startup.
 *
 * `config` is the merged + env-overridden config after credential
 * stripping; `active` is the cascaded active-state triple;
 * `projectFilePath` is the absolute path of the discovered
 * `.cccollab.json` (if any) for log messages; `locations` is a
 * per-location view that `server.ts` iterates to construct transports.
 *
 * The reserved `local` location is always present in `locations`, even
 * when the user's config does not mention it - matching the rule that
 * `local` is always implicitly available.
 */
export interface ResolvedConfig {
  config: UserCccollabConfig
  active: ResolvedActive
  projectFilePath: string | null
  locations: ResolvedLocation[]
}

export interface ResolvedLocation {
  name: string
  isLocal: boolean
  url?: string
  authType?: 'clerk'
  accessToken?: string
  refreshToken?: string
  accessTokenExpiresAt?: number
  clerkIssuer?: string
  clerkClientId?: string
  clerkRedirectPort?: number
  userEmail?: string
  userId?: string
  updatedAt?: number
  channels: ResolvedChannel[]
}

export interface ResolvedChannel {
  name: string
  topics: ResolvedTopic[]
}

export interface ResolvedTopic {
  name: string
}

/**
 * Orchestrate the full load → merge → env → strip-creds → cascade
 * pipeline. Called once at startup from `server.ts`.
 *
 * Environment variables are threaded through an explicit parameter
 * (default `process.env`) so tests can drive the pipeline without
 * having to mutate the real env.
 */
export function resolveConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const user = loadUserConfig()
  const project = loadProjectConfig(cwd)

  // Strip credentials from the project-level file BEFORE merging; the
  // user-level file keeps its credentials untouched. This makes the
  // merge result "user credentials + project everything else" which
  // matches the intended separation of concerns.
  const strippedProject =
    project.filePath === null ? project.config : stripProjectCredentials(project.config, project.filePath).stripped

  const merged = mergeConfigs(user, strippedProject)
  const withDefaults = applyDefaults(merged, env)
  const withEnv = applyEnvOverrides(withDefaults, env)

  // Always ensure `local` is present in the resolved view.
  const final: UserCccollabConfig = withEnv
  if (!final.locations) {
    final.locations = {}
  }
  if (!(LOCAL_LOCATION in final.locations)) {
    final.locations[LOCAL_LOCATION] = {}
  }

  const active = resolveActive(final)

  const locations = Object.entries(final.locations).map(([name, raw]): ResolvedLocation => {
    const loc = (raw ?? {}) as UserLocationConfig
    const channels = Object.entries(loc.channels ?? {}).map(([channelName, channelRaw]): ResolvedChannel => {
      const topics = Object.entries(channelRaw?.topics ?? {}).map(([topicName]): ResolvedTopic => ({ name: topicName }))
      return { name: channelName, topics }
    })
    return {
      name,
      isLocal: name === LOCAL_LOCATION,
      url: loc.url,
      authType: loc.authType,
      accessToken: loc.accessToken,
      refreshToken: loc.refreshToken,
      accessTokenExpiresAt: loc.accessTokenExpiresAt,
      clerkIssuer: loc.clerkIssuer,
      clerkClientId: loc.clerkClientId,
      clerkRedirectPort: loc.clerkRedirectPort,
      userEmail: loc.userEmail,
      userId: loc.userId,
      updatedAt: loc.updatedAt,
      channels,
    }
  })

  return {
    config: final,
    active,
    projectFilePath: project.filePath,
    locations,
  }
}
