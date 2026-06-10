import {
  DEFAULT_CLERK_CLIENT_ID,
  DEFAULT_CLERK_ISSUER,
  DEFAULT_REMOTE_LOCATION_NAME,
  DEFAULT_REMOTE_URL,
} from '../constants.js'
import { LOCAL_LOCATION, type UserCccollabConfig } from './schema.js'

/**
 * Inject defaults for the hosted KAI-backed remote location.
 *
 * Runs after `mergeConfigs` and before `applyEnvOverrides` in the
 * resolve pipeline. That ordering keeps env vars and explicit
 * user/project config strictly higher precedence than the baked-in
 * defaults.
 *
 * Rules:
 *  1. If no non-`local` location exists in the merged config,
 *     synthesize one named DEFAULT_REMOTE_LOCATION_NAME. It is added
 *     present-but-inactive: never marked `active`. This makes the
 *     hosted backend available (so `set_active_location remote` works once
 *     the user authenticates) without auto-activating it or routing
 *     messages there on startup. Auto-activation is deliberately
 *     deferred to later work; leaving the synthesized location inactive
 *     restores the prior "no location auto-active on a fresh install"
 *     behavior and keeps the "at most one active location" invariant
 *     trivially satisfied (zero active is valid - see `resolveActive`).
 *  2. If a non-`local` location exists but is missing any of
 *     `url`, `clerkIssuer`, `clerkClientId`, fill the missing field(s)
 *     from defaults. Explicit user-supplied values always win.
 *
 * Credential fields (`accessToken`, `refreshToken`, etc.) are never
 * written by this function — those continue to flow only from the
 * user-level file.
 */
export function applyDefaults(config: UserCccollabConfig): UserCccollabConfig {
  const next = structuredClone(config) as UserCccollabConfig
  next.locations = next.locations ?? {}

  const nonLocalEntries = Object.entries(next.locations).filter(([name]) => name !== LOCAL_LOCATION)

  if (nonLocalEntries.length === 0) {
    // Present-but-inactive: never marked `active`. Activation is deferred
    // to later work, so a fresh install does not auto-route messages to the
    // hosted backend before the user has authenticated and opted in.
    next.locations[DEFAULT_REMOTE_LOCATION_NAME] = {
      url: DEFAULT_REMOTE_URL,
      authType: 'clerk',
      clerkIssuer: DEFAULT_CLERK_ISSUER,
      clerkClientId: DEFAULT_CLERK_CLIENT_ID,
    }
    return next
  }

  for (const [name, raw] of nonLocalEntries) {
    const loc = raw ?? {}
    next.locations[name] = {
      ...loc,
      url: loc.url ?? DEFAULT_REMOTE_URL,
      clerkIssuer: loc.clerkIssuer ?? DEFAULT_CLERK_ISSUER,
      clerkClientId: loc.clerkClientId ?? DEFAULT_CLERK_CLIENT_ID,
      // `authType` left alone if the user set it; otherwise default to clerk
      // so downstream code that branches on it sees a stable value.
      authType: loc.authType ?? 'clerk',
    }
  }

  return next
}
