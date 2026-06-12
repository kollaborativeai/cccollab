import {
  DEFAULT_CLERK_CLIENT_ID,
  DEFAULT_CLERK_ISSUER,
  DEFAULT_REMOTE_LOCATION_NAME,
  DEFAULT_REMOTE_URL,
} from '../constants.js'
import { LOCAL_LOCATION, type UserCccollabConfig } from './schema.js'

/** Env var that suppresses the baked-in hosted-backend default entirely.
 *  Any non-empty value opts out: no default location is synthesized and
 *  no baked pointer is filled in. For privacy-sensitive / self-hosting
 *  setups that don't want the production KAI pointer present at all. */
const OPT_OUT_ENV = 'CCCOLLAB_NO_DEFAULT_REMOTE'

/**
 * Inject defaults for the hosted KAI-backed remote location.
 *
 * Runs after `mergeConfigs` and before `applyEnvOverrides` in the
 * resolve pipeline. That ordering keeps env vars and explicit
 * user/project config strictly higher precedence than the baked-in
 * defaults.
 *
 * Defaults only ever touch the location named DEFAULT_REMOTE_LOCATION_NAME
 * (`remote`) — never any other non-`local` location. This is deliberate:
 * a user who declares their own `selfhosted` (or any non-`remote`) location
 * must remain completely unaffected, so the loud "missing clerkIssuer /
 * clerkClientId" and "non-local location must have a url" validations keep
 * firing for an incomplete self-hosted entry instead of being silently
 * back-filled with KAI's production pointer.
 *
 * Behavior:
 *  - If a `remote` entry exists (declared by the user, or carried over with
 *    persisted credentials), fill only its missing `url` / `clerkIssuer` /
 *    `clerkClientId` / `authType`. Explicit user-supplied values always win.
 *  - Otherwise, if NO non-`local` location exists at all, synthesize
 *    `remote` from the baked pointer. It is added present-but-inactive:
 *    never marked `active`, so a fresh install does not auto-route messages
 *    to the hosted backend before the user authenticates and opts in. (To
 *    engage it after `authenticate`, `join_channel` / `set_active_channel`
 *    with `location: "remote"`. Auto-activation is deferred to later work;
 *    zero active locations is valid — see `resolveActive`.)
 *  - Otherwise (a different non-`local` location exists and no `remote`
 *    entry), leave the config untouched.
 *
 * Set CCCOLLAB_NO_DEFAULT_REMOTE to any non-empty value to suppress all of
 * the above.
 *
 * Credential fields (`accessToken`, `refreshToken`, etc.) are never
 * written by this function — those continue to flow only from the
 * user-level file.
 */
export function applyDefaults(config: UserCccollabConfig, env: NodeJS.ProcessEnv = {}): UserCccollabConfig {
  const next = structuredClone(config) as UserCccollabConfig
  next.locations = next.locations ?? {}

  // Opt-out: leave the config exactly as configured, with no baked pointer.
  if ((env[OPT_OUT_ENV] ?? '').trim() !== '') {
    return next
  }

  const existingDefault = next.locations[DEFAULT_REMOTE_LOCATION_NAME]
  if (existingDefault) {
    // The default-named location was declared explicitly (or carries
    // persisted credentials). Fill only its missing fields; user wins.
    next.locations[DEFAULT_REMOTE_LOCATION_NAME] = {
      ...existingDefault,
      url: existingDefault.url ?? DEFAULT_REMOTE_URL,
      clerkIssuer: existingDefault.clerkIssuer ?? DEFAULT_CLERK_ISSUER,
      clerkClientId: existingDefault.clerkClientId ?? DEFAULT_CLERK_CLIENT_ID,
      authType: existingDefault.authType ?? 'clerk',
    }
    return next
  }

  const hasNonLocal = Object.keys(next.locations).some((name) => name !== LOCAL_LOCATION)
  if (hasNonLocal) {
    // A user-defined non-`local` location exists under a different name.
    // Do not synthesize `remote` and do not touch the user's location.
    return next
  }

  // No non-`local` location at all → synthesize `remote`, present-but-inactive.
  next.locations[DEFAULT_REMOTE_LOCATION_NAME] = {
    url: DEFAULT_REMOTE_URL,
    authType: 'clerk',
    clerkIssuer: DEFAULT_CLERK_ISSUER,
    clerkClientId: DEFAULT_CLERK_CLIENT_ID,
  }
  return next
}
