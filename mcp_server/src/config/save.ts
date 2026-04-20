import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
 */
export function saveLocationAuth(locationName: string, auth: LocationAuth): void {
  ensureHomeDir()

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
  } catch {
    // Corrupt or schema-violating user-level file: start fresh so
    // `saveLocationAuth` still succeeds. The corrupt content is
    // overwritten atomically below. A future iteration could rename
    // the bad file aside for forensics.
    return {}
  }
}

function ensureHomeDir(): void {
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  const parent = dirname(CCCOLLAB_CONFIG_FILE)
  mkdirSync(parent, { recursive: true })
}
