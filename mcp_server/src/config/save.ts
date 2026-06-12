import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { CCCOLLAB_CONFIG_FILE, CCCOLLAB_HOME } from '../constants.js'
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
 * Cross-process lock around the read-modify-write of the user-level
 * config file. Convex Auth refresh tokens are single-use: two MCP
 * processes refreshing the same location concurrently can otherwise
 * race the read-then-rename and silently lose one process's update,
 * which then forces a re-authentication on the next refresh attempt
 * because the in-memory refresh token no longer matches the persisted
 * one. The lock serialises the critical section across processes on
 * the same machine.
 *
 * Semantics:
 *   - Lock file is a sibling of the config file (`<file>.lock`).
 *   - The holder writes its PID into the lock file as the body.
 *   - Acquired with `writeFileSync({flag: 'wx'})` so creation is
 *     atomic — the OS guarantees only one creator wins the EEXIST
 *     race.
 *   - Released by deleting the file in `finally`.
 *   - A lock is only treated as abandoned (and reaped) when its mtime
 *     is older than STALE_LOCK_MS AND the PID inside is no longer a
 *     live process. The two-condition check prevents a slow-but-alive
 *     holder (NFS hang, swap thrash, debugger SIGSTOP) from being
 *     reaped concurrently with its own write — a same-machine concern
 *     since the lock only protects same-machine contention anyway.
 *   - We poll on EEXIST with short backoff up to `LOCK_TIMEOUT_MS`. In
 *     the common case (no contention) the loop runs once.
 */
const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000
const LOCK_POLL_MS = 50

/** Backing buffer for `Atomics.wait` — the standard Node.js mechanism for
 *  a sync sleep without burning CPU. Allocated once at module scope so the
 *  acquireLock retry loop doesn't churn a fresh SharedArrayBuffer per
 *  iteration. The integer value is never read or written; only the
 *  blocking semantics of `Atomics.wait(buf, 0, 0, ms)` — which sleeps for
 *  up to `ms` ms and returns 'timed-out' since no one ever calls
 *  Atomics.notify — are used. */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

function syncSleep(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms)
}

function lockFilePath(): string {
  return `${CCCOLLAB_CONFIG_FILE}.lock`
}

/** True if `pid` is unset, unparseable, or no longer a live process on
 *  this machine. `process.kill(pid, 0)` is the standard liveness probe:
 *  signal 0 performs the existence/permission check without delivering
 *  anything. ESRCH (no such process) means dead; EPERM means alive but
 *  owned by another user (still alive — don't reap). Any other thrown
 *  error is treated conservatively as "still alive" so we never reap a
 *  lock we can't prove is dead. */
function isPidDead(raw: string): boolean {
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function acquireLock(): void {
  const lock = lockFilePath()
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Reap a stale lock only if the holder is provably gone — both
      // mtime past the staleness threshold AND PID no longer alive.
      // Reaping a slow-but-alive holder would let two processes into
      // the critical section together.
      try {
        const age = Date.now() - statSync(lock).mtimeMs
        if (age > STALE_LOCK_MS) {
          let holderPid = ''
          try {
            holderPid = readFileSync(lock, 'utf-8')
          } catch {
            /* lock vanished; retry */
          }
          if (isPidDead(holderPid)) {
            try {
              unlinkSync(lock)
            } catch {
              /* another waiter unlinked it first; fall through to retry */
            }
            continue
          }
        }
      } catch {
        // Lock vanished between EEXIST and stat: retry immediately.
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `cccollab: timed out after ${LOCK_TIMEOUT_MS}ms waiting for ${lock}. ` +
            `If you are sure no other cccollab process is running, delete the lock file and try again.`,
          { cause: err },
        )
      }
      // Sleep briefly before retrying. `saveLocationAuth` is synchronous,
      // so we can't await `setTimeout`; `Atomics.wait` is the standard
      // Node sync-sleep primitive that does not burn CPU. Under
      // contention by multiple MCP processes this keeps the waiter at
      // ~0% CPU instead of pegging a core.
      syncSleep(LOCK_POLL_MS)
    }
  }
}

function releaseLock(): void {
  try {
    unlinkSync(lockFilePath())
  } catch {
    // Best-effort: a stale-lock reaper from a peer may have already
    // unlinked the file. Either way, the lock is no longer held.
  }
}

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
 * the same `~/.cccollab/config.json` cannot lose updates. See the
 * `acquireLock` / `releaseLock` block above for the lock protocol.
 */
export function saveLocationAuth(locationName: string, auth: LocationAuth): void {
  ensureHomeDir()
  acquireLock()
  try {
    writeLocationAuthInLock(locationName, auth)
  } finally {
    releaseLock()
  }
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

  const tmp = `${CCCOLLAB_CONFIG_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // chmod failed (probably Windows); tolerated - the mode arg above
    // already covers POSIX.
  }
  renameSync(tmp, CCCOLLAB_CONFIG_FILE)
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
  acquireLock()
  try {
    return await callback(writeLocationAuthInLock)
  } finally {
    releaseLock()
  }
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
