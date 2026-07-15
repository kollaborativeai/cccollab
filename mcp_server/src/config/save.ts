import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

import { CCCOLLAB_CONFIG_FILE, CCCOLLAB_HOME } from '../constants.js'
import { withFileLock, withFileLockSync, writeFileAtomic } from '../file-lock.js'
import { UserCccollabConfigSchema, type UserLocationConfig } from './schema.js'

export interface ClerkLocationAuth {
  authType: 'clerk'
  url?: string
  accessToken: string
  refreshToken: string
  /** OIDC ID token (JWT) — the token sent to Convex. Its `aud` is the OAuth
   *  Client ID, matching the deployment's auth.config.ts provider. */
  idToken: string
  /** Unix epoch milliseconds at which the access token expires. Required so
   *  the refresh path can determine token liveness without an introspection
   *  round-trip. */
  accessTokenExpiresAt: number
  /** The Clerk app-pointer the tokens were minted against. Persisted with
   *  the tokens so the refresh path always uses the issuer/client that
   *  issued the refresh token - even when the issuer originally came from a
   *  `CCCOLLAB_CLERK_*` env override that is absent in a later session.
   *  Without this, a stale on-disk issuer makes refresh POST the refresh
   *  token to the wrong Clerk instance, which rejects it. */
  clerkIssuer?: string
  clerkClientId?: string
  userEmail?: string
  userId?: string
  updatedAt?: number
}

export type LocationAuth = ClerkLocationAuth

/**
 * Persist auth state for a single location into the user-level config
 * file (`~/.cccollab/config.json`). Written with mode `0600` - the
 * access token and refresh token are long-lived secrets that must not
 * be world-readable.
 *
 * Merge semantics: the named location's auth fields are overwritten;
 * everything else in the user-level file (other locations, other
 * top-level fields) is preserved. If the file doesn't exist yet,
 * creates it with a minimal shape.
 *
 * Atomic on POSIX: writes to a sibling `<file>.<pid>.tmp` and renames
 * so a crash mid-write can't leave a truncated token on disk. Windows'
 * NTFS rename is less strict but avoids the chmod path; callers there
 * get best-effort.
 *
 * Cross-process safe: the read-modify-write is wrapped in a lock file
 * so two MCP processes refreshing tokens for different locations in
 * the same `~/.cccollab/config.json` cannot lose updates. This matters
 * here specifically because Convex Auth refresh tokens are single-use:
 * two processes racing the read-then-rename would silently lose one
 * process's update, forcing a re-authentication on the next refresh
 * because the in-memory refresh token no longer matches the persisted
 * one. See `src/file-lock.ts` for the lock protocol.
 */
export function saveLocationAuth(locationName: string, auth: LocationAuth): void {
  ensureHomeDir()
  withFileLockSync(CCCOLLAB_CONFIG_FILE, () => writeLocationAuthInLock(locationName, auth))
}

/**
 * Inner read-modify-write of `saveLocationAuth`, factored out so callers
 * already holding the config lock (via `withConfigLock`) can perform
 * the persist step without re-entering the lock — re-entering would
 * deadlock because the lock is not reentrant. External callers must
 * use `saveLocationAuth` instead.
 */
function writeLocationAuthInLock(locationName: string, auth: LocationAuth): void {
  const existing = readExisting()
  const next = existing
  next.locations = next.locations ?? {}
  const prior = (next.locations[locationName] as UserLocationConfig | undefined) ?? {}
  next.locations[locationName] = {
    ...prior,
    ...(auth.url !== undefined ? { url: auth.url } : {}),
    authType: 'clerk' as const,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    idToken: auth.idToken,
    accessTokenExpiresAt: auth.accessTokenExpiresAt,
    ...(auth.clerkIssuer !== undefined ? { clerkIssuer: auth.clerkIssuer } : {}),
    ...(auth.clerkClientId !== undefined ? { clerkClientId: auth.clerkClientId } : {}),
    ...(auth.userEmail !== undefined ? { userEmail: auth.userEmail } : {}),
    ...(auth.userId !== undefined ? { userId: auth.userId } : {}),
    updatedAt: auth.updatedAt ?? Date.now(),
  }

  writeFileAtomic(CCCOLLAB_CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 0o600)
}

/**
 * Run an arbitrary critical section under the config lock. The
 * callback receives a `persist` function it can use to write a
 * location's auth atomically inside the same lock acquisition; this is
 * the only way to combine a re-read with a save without a TOCTOU gap
 * across processes.
 *
 * The refresh path in `remote/client.ts` uses this to: (1) read the
 * current persisted refresh token from disk, (2) decide whether to
 * issue a refresh call or adopt tokens written by a peer process, and
 * (3) persist any new tokens — all under the same lock, so two
 * processes refreshing the same location can never both consume the
 * same single-use refresh token.
 *
 * The callback may be async; the lock is released in `finally` so a
 * thrown rejection releases cleanly.
 */
export async function withConfigLock<T>(
  callback: (persist: (locationName: string, auth: LocationAuth) => void) => Promise<T>,
): Promise<T> {
  ensureHomeDir()
  return withFileLock(CCCOLLAB_CONFIG_FILE, () => callback(writeLocationAuthInLock))
}

/**
 * Read the persisted auth fields for one location, or null if the file
 * is absent / unreadable / has no entry for this location. Does NOT
 * acquire the lock; callers that need a coherent read+write should
 * call this from within `withConfigLock`.
 *
 * Returns `authType` so the refresh path can decide which flow to use,
 * and `accessTokenExpiresAt` so it can determine whether the access token is
 * still live. Also surfaces `clerkIssuer` / `clerkClientId` if present on
 * disk — in normal operation these fields come from the resolved (merged)
 * project config, not from this file; they appear here only for
 * user-hand-edited configs and as a forward-compatibility hook.
 */
export function loadPersistedLocationAuth(locationName: string): {
  url?: string
  authType?: 'clerk'
  accessToken?: string
  refreshToken?: string
  idToken?: string
  accessTokenExpiresAt?: number
  clerkIssuer?: string
  clerkClientId?: string
  userEmail?: string
  userId?: string
} | null {
  // `readExisting` throws on a corrupt / schema-violating file. The
  // documented contract here is "absent or unreadable → null", so a
  // throw is caught and folded into null: the refresh path then degrades
  // to unauthenticated rather than crashing on a bad config.
  let existing: { locations?: Record<string, UserLocationConfig>; [key: string]: unknown }
  try {
    existing = readExisting()
  } catch {
    return null
  }
  const loc = existing.locations?.[locationName] as UserLocationConfig | undefined
  if (!loc) return null
  return {
    url: loc.url,
    authType: loc.authType,
    accessToken: loc.accessToken,
    refreshToken: loc.refreshToken,
    idToken: loc.idToken,
    accessTokenExpiresAt: loc.accessTokenExpiresAt,
    clerkIssuer: loc.clerkIssuer,
    clerkClientId: loc.clerkClientId,
    userEmail: loc.userEmail,
    userId: loc.userId,
  }
}

/**
 * Delete the user-level config file (if present). Used by tests that
 * want a clean slate and by a future `sign-out --all` flow.
 */
export function clearUserConfig(): void {
  if (existsSync(CCCOLLAB_CONFIG_FILE)) {
    unlinkSync(CCCOLLAB_CONFIG_FILE)
  }
}

function readExisting(): { locations?: Record<string, UserLocationConfig>; [key: string]: unknown } {
  if (!existsSync(CCCOLLAB_CONFIG_FILE)) {
    return {}
  }
  const raw = readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8')
  // A prior config that exists but cannot be parsed is NOT treated as an
  // empty baseline: doing so let `writeLocationAuthInLock` overwrite the
  // file with a fresh config that dropped every other location and the
  // clerk app-pointer fields (clerkIssuer / clerkClientId), which then
  // crashed the next server start. Throw instead — the caller aborts the
  // write, the file is left untouched (so a transient read can be retried
  // and a genuine corruption can be hand-fixed), and the failure is loud.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `cccollab: ${CCCOLLAB_CONFIG_FILE} is not valid JSON (${err instanceof Error ? err.message : String(err)}); ` +
        `refusing to overwrite it — fix or remove the file and retry.`,
      { cause: err },
    )
  }
  try {
    const validated = UserCccollabConfigSchema.parse(parsed)
    // Cast to the looser shape we merge against.
    return validated as { locations?: Record<string, UserLocationConfig>; [key: string]: unknown }
  } catch (err) {
    throw new Error(
      `cccollab: ${CCCOLLAB_CONFIG_FILE} failed schema validation (${err instanceof Error ? err.message : String(err)}); ` +
        `refusing to overwrite it — fix or remove the file and retry.`,
      { cause: err },
    )
  }
}

function ensureHomeDir(): void {
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  const parent = dirname(CCCOLLAB_CONFIG_FILE)
  mkdirSync(parent, { recursive: true })
}
