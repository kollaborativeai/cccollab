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
import { CccollabConfigSchema, type LocationConfig } from './schema.js'

export interface LocationAuth {
  url?: string
  accessToken: string
  refreshToken: string
  userEmail?: string
  userId?: string
  updatedAt?: number
}

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
 *   - Acquired with `writeFileSync({flag: 'wx'})` so creation is
 *     atomic — the OS guarantees only one creator wins the EEXIST
 *     race.
 *   - Released by deleting the file in `finally`.
 *   - A lock older than `STALE_LOCK_MS` is treated as abandoned (the
 *     holding process crashed before its `finally` could run). The
 *     waiter unlinks it and retries.
 *   - We poll on EEXIST with short backoff up to `LOCK_TIMEOUT_MS`. In
 *     the common case (no contention) the loop runs once.
 */
const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000
const LOCK_POLL_MS = 50

function lockFilePath(): string {
  return `${CCCOLLAB_CONFIG_FILE}.lock`
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
      // Reap a stale lock so we don't deadlock behind a crashed peer.
      try {
        const age = Date.now() - statSync(lock).mtimeMs
        if (age > STALE_LOCK_MS) {
          try {
            unlinkSync(lock)
          } catch {
            /* another waiter unlinked it first; fall through to retry */
          }
          continue
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
      // Busy-wait briefly. saveLocationAuth itself is sync, so we can't
      // await a setTimeout — burn the cycles. The poll interval keeps
      // the spin cheap.
      const until = Date.now() + LOCK_POLL_MS
      while (Date.now() < until) {
        /* spin */
      }
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
    const existing = readExisting()
    const next = existing
    next.locations = next.locations ?? {}
    const prior = (next.locations[locationName] as LocationConfig | undefined) ?? {}
    next.locations[locationName] = {
      ...prior,
      ...(auth.url !== undefined ? { url: auth.url } : {}),
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
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
  } finally {
    releaseLock()
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

function readExisting(): { locations?: Record<string, LocationConfig>; [key: string]: unknown } {
  if (!existsSync(CCCOLLAB_CONFIG_FILE)) {
    return {}
  }
  try {
    const raw = readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    const validated = CccollabConfigSchema.parse(parsed)
    // Cast to the looser shape we merge against.
    return validated as { locations?: Record<string, LocationConfig>; [key: string]: unknown }
  } catch (err) {
    // Corrupt or schema-violating user-level file. Preserve the bad
    // content for forensics by renaming it to a timestamped sibling
    // before the caller's `saveLocationAuth` overwrites the path. The
    // backup rename is best-effort: if it fails (permissions, missing
    // directory, etc.) we still fall through to the `{}` baseline so the
    // save path stays robust. The user gets one console.error line so
    // the incident isn't completely silent.
    const backupPath = `${CCCOLLAB_CONFIG_FILE}.bak.${Date.now()}`
    try {
      renameSync(CCCOLLAB_CONFIG_FILE, backupPath)
      process.stderr.write(
        `cccollab: user config at ${CCCOLLAB_CONFIG_FILE} failed to parse (${err instanceof Error ? err.message : String(err)}); backed up to ${backupPath}\n`,
      )
    } catch (backupErr) {
      process.stderr.write(
        `cccollab: user config at ${CCCOLLAB_CONFIG_FILE} failed to parse (${err instanceof Error ? err.message : String(err)}); backup also failed (${backupErr instanceof Error ? backupErr.message : String(backupErr)})\n`,
      )
    }
    return {}
  }
}

function ensureHomeDir(): void {
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  const parent = dirname(CCCOLLAB_CONFIG_FILE)
  mkdirSync(parent, { recursive: true })
}
