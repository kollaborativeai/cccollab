import {
  DEFAULT_CLERK_CLIENT_ID,
  DEFAULT_CLERK_ISSUER,
  DEFAULT_REMOTE_LOCATION_NAME,
  DEFAULT_REMOTE_URL,
} from '../constants.js'
import { LOCAL_LOCATION, type UserCccollabConfig, type UserLocationConfig } from './schema.js'

/**
 * Inject defaults for the hosted KAI-backed remote location.
 *
 * Runs after `mergeConfigs` and before `applyEnvOverrides` in the
 * resolve pipeline. That ordering keeps env vars and explicit
 * user/project config strictly higher precedence than the baked-in
 * defaults.
 *
 * Rules (this task only implements rule 1; rule 2 lands in Task 8):
 *  1. If no non-`local` location exists in the merged config,
 *     synthesize one named DEFAULT_REMOTE_LOCATION_NAME and mark it
 *     active.
 *  2. (Task 8) If a non-`local` location exists but is missing any of
 *     `url`, `clerkIssuer`, `clerkClientId`, fill the missing field(s)
 *     from defaults.
 *
 * Credential fields (`accessToken`, etc.) are never written by this
 * function — those continue to flow only from the user-level file.
 */
export function applyDefaults(config: UserCccollabConfig): UserCccollabConfig {
  const next = structuredClone(config) as UserCccollabConfig
  next.locations = next.locations ?? {}

  const hasNonLocal = Object.keys(next.locations).some((name) => name !== LOCAL_LOCATION)
  if (!hasNonLocal) {
    const synth: UserLocationConfig = {
      url: DEFAULT_REMOTE_URL,
      authType: 'clerk',
      clerkIssuer: DEFAULT_CLERK_ISSUER,
      clerkClientId: DEFAULT_CLERK_CLIENT_ID,
      active: true,
    }
    next.locations[DEFAULT_REMOTE_LOCATION_NAME] = synth
  }

  return next
}
