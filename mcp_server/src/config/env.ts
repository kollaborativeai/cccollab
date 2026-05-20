import { LOCAL_LOCATION, type UserCccollabConfig, type UserLocationConfig } from './schema.js'

/**
 * Environment-variable overrides for the unified cccollab config.
 *
 * These are applied AFTER the user-level + project-level files have
 * been merged, so they win over anything on disk. Recognised env vars:
 *
 *   CCCOLLAB_NAME
 *     Overrides the top-level `name` (the session's display name). Used
 *     by the local test harness (`test/start.sh`) to pre-seed per-
 *     invocation identity without having to write a temporary config
 *     file.
 *
 *   CCCOLLAB_OBJECTIVE
 *     Overrides the top-level `objective`. Same motivation as
 *     CCCOLLAB_NAME.
 *
 *   CCCOLLAB_REMOTE_URL
 *     Register (or update) a location named `remote` with this URL and
 *     mark it as the active location. Any other location's `active`
 *     flag is cleared so "exactly one active location" holds in the
 *     final resolved config. The `remote` name is conventional only -
 *     it's the label used by the env var, not a reserved key (the only
 *     reserved name is `local`).
 *
 *   CCCOLLAB_CLERK_ISSUER
 *   CCCOLLAB_CLERK_CLIENT_ID
 *     The Clerk app pointer. Set together with CCCOLLAB_REMOTE_URL so a
 *     one-line `export …` flow yields a complete, working remote
 *     location without an on-disk config. Applied to the same target
 *     CCCOLLAB_AUTH_TOKEN historically picked: the env-registered
 *     `remote` from CCCOLLAB_REMOTE_URL wins, else the first existing
 *     non-local active location, else a no-op.
 */
const REMOTE_ENV_LOCATION = 'remote'

export function applyEnvOverrides(config: UserCccollabConfig, env: NodeJS.ProcessEnv): UserCccollabConfig {
  // Structured clone so the caller's object is never mutated. Env
  // overrides are last-writer-wins, and the cascade resolver works off
  // the returned shape.
  const next = structuredClone(config) as UserCccollabConfig

  const envName = stringOrUndefined(env.CCCOLLAB_NAME)
  const envObjective = stringOrUndefined(env.CCCOLLAB_OBJECTIVE)
  if (envName !== undefined) next.name = envName.trim()
  if (envObjective !== undefined) next.objective = envObjective.trim()

  const envUrl = stringOrUndefined(env.CCCOLLAB_REMOTE_URL)
  const envClerkIssuer = stringOrUndefined(env.CCCOLLAB_CLERK_ISSUER)
  const envClerkClientId = stringOrUndefined(env.CCCOLLAB_CLERK_CLIENT_ID)

  if (envUrl !== undefined) {
    next.locations = next.locations ?? {}
    // Clear every existing location's active flag so only the
    // env-registered one is active after this pass. The cascade in
    // active.ts treats a location as active when it has any active
    // channel or topic (see schema.ts), so we must also strip
    // `active` from every nested channel and topic - otherwise the
    // cascade re-promotes the location we just deactivated and the
    // resolver throws "exactly one active location required".
    for (const [, location] of Object.entries(next.locations)) {
      if (location) {
        clearActiveCascade(location)
      }
    }
    const existing = (next.locations[REMOTE_ENV_LOCATION] as UserLocationConfig | undefined) ?? {}
    next.locations[REMOTE_ENV_LOCATION] = {
      ...existing,
      url: envUrl,
      active: true,
    }
  }

  if (envClerkIssuer !== undefined || envClerkClientId !== undefined) {
    const target = pickAuthTarget(next)
    if (target !== null) {
      if (envClerkIssuer !== undefined) target.clerkIssuer = envClerkIssuer
      if (envClerkClientId !== undefined) target.clerkClientId = envClerkClientId
      // The Clerk auth flow needs an explicit authType marker only when
      // saved tokens round-trip through `saveLocationAuth`; the
      // env-override path doesn't write to disk so leaving `authType`
      // implicit is fine. Still, set it for clarity in any downstream
      // log/dump that prints the resolved config.
      target.authType = 'clerk'
    }
  }

  return next
}

function stringOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() === '' ? undefined : value
}

/**
 * Strip `active` flags from a location and every channel and topic
 * inside it. Called when CCCOLLAB_REMOTE_URL hands activeness to the
 * env-registered `remote` location: any leftover active flag at any
 * depth would let the cascade in active.ts re-promote the location.
 */
function clearActiveCascade(location: UserLocationConfig): void {
  delete (location as { active?: boolean }).active
  if (!location.channels) return
  for (const channel of Object.values(location.channels)) {
    if (!channel) continue
    delete (channel as { active?: boolean }).active
    if (!channel.topics) continue
    for (const topic of Object.values(channel.topics)) {
      if (!topic) continue
      delete (topic as { active?: boolean }).active
    }
  }
}

/**
 * Pick the location the env-provided auth token should attach to.
 * Strategy:
 *
 *  1. If an env-registered `remote` location exists (it will whenever
 *     CCCOLLAB_REMOTE_URL was set this pass), use it.
 *  2. Otherwise scan all non-local locations for the one with
 *     `active: true`.
 *  3. Otherwise null - the token has nowhere to land.
 *
 * Returns a mutable reference into `config.locations` so the caller
 * can assign `accessToken` directly.
 */
function pickAuthTarget(config: UserCccollabConfig): UserLocationConfig | null {
  if (!config.locations) return null
  const remote = config.locations[REMOTE_ENV_LOCATION]
  if (remote) return remote
  for (const [name, location] of Object.entries(config.locations)) {
    if (name === LOCAL_LOCATION) continue
    if (location?.active === true) return location
  }
  return null
}
