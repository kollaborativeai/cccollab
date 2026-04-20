import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { CCCOLLAB_CONFIG_FILE, CCCOLLAB_HOME } from '../constants.js'

/**
 * On-disk shape of the cccollab remote-mode config file.
 *
 * The file holds the remote deployment URL, the OAuth access token,
 * and the refresh token. Written with mode `0600` - the token and
 * refresh token are long-lived secrets that must not be world-readable.
 *
 * Presence of `remoteUrl` alone is NOT enough to declare remote mode
 * usable; `accessToken` must also be present. `authenticate` writes
 * all three atomically via the rename trick below.
 *
 * ## Backwards compatibility
 *
 * Pre-CCC-3-wire-up versions persisted the URL under `hostedUrl`. The
 * read path below accepts the legacy field and the new field, always
 * surfacing it to callers as `remoteUrl`. The write path only emits
 * `remoteUrl`; a legacy file gets silently rewritten on the next save.
 * The env-var precedence is: `CCCOLLAB_REMOTE_URL` (new) > legacy
 * `CCCOLLAB_HOSTED_URL` > file.
 */
export interface RemoteConfig {
  remoteUrl: string
  accessToken: string
  refreshToken: string
  userEmail?: string
  userId?: string
  updatedAt: number
}

/** Subset of `RemoteConfig` that is safe to log. Never log tokens. */
export interface RemoteConfigSummary {
  remoteUrl: string
  userEmail?: string
  userId?: string
  hasAccessToken: boolean
  hasRefreshToken: boolean
  updatedAt?: number
  source: 'file' | 'env' | 'mixed'
}

/**
 * Load remote config.
 *
 * Precedence: environment variables win over the file, so CI or
 * programmatic callers can override without touching disk. When both a
 * file and env vars are present, `remoteUrl` follows env, tokens follow
 * env. Missing pieces are filled from the file.
 *
 * Returns `null` when neither file nor env supplies at least a
 * `remoteUrl`; callers treat that as "remote mode not configured".
 */
export function loadRemoteConfig(): RemoteConfig | null {
  const file = readFile()
  const envUrl = process.env.CCCOLLAB_REMOTE_URL ?? process.env.CCCOLLAB_HOSTED_URL
  const envToken = process.env.CCCOLLAB_AUTH_TOKEN
  const envRefresh = process.env.CCCOLLAB_AUTH_REFRESH_TOKEN

  const remoteUrl = envUrl ?? file?.remoteUrl ?? null
  if (remoteUrl === null || remoteUrl === '') return null

  const accessToken = envToken ?? file?.accessToken
  const refreshToken = envRefresh ?? file?.refreshToken
  if (!accessToken || !refreshToken) {
    // URL present but no tokens - caller should treat as "configured
    // but not authenticated yet".
    return {
      remoteUrl,
      accessToken: accessToken ?? '',
      refreshToken: refreshToken ?? '',
      userEmail: file?.userEmail,
      userId: file?.userId,
      updatedAt: file?.updatedAt ?? 0,
    }
  }

  return {
    remoteUrl,
    accessToken,
    refreshToken,
    userEmail: file?.userEmail,
    userId: file?.userId,
    updatedAt: file?.updatedAt ?? Date.now(),
  }
}

/**
 * Produce a token-free summary of the current config for logging /
 * `whoami` output. Never exposes tokens.
 */
export function summarizeRemoteConfig(): RemoteConfigSummary | null {
  const cfg = loadRemoteConfig()
  if (cfg === null) return null
  const sourceIsEnv =
    process.env.CCCOLLAB_REMOTE_URL !== undefined ||
    process.env.CCCOLLAB_HOSTED_URL !== undefined ||
    process.env.CCCOLLAB_AUTH_TOKEN !== undefined
  const sourceIsFile = readFile() !== null
  const source: RemoteConfigSummary['source'] = sourceIsEnv && sourceIsFile ? 'mixed' : sourceIsEnv ? 'env' : 'file'
  return {
    remoteUrl: cfg.remoteUrl,
    userEmail: cfg.userEmail,
    userId: cfg.userId,
    hasAccessToken: cfg.accessToken !== '',
    hasRefreshToken: cfg.refreshToken !== '',
    updatedAt: cfg.updatedAt || undefined,
    source,
  }
}

/**
 * Persist the remote config atomically with `chmod 0600`. Uses a
 * tmp-rename pattern so a crash mid-write can't leave a partial token
 * on disk (the rename is atomic on POSIX filesystems).
 *
 * On Windows the `chmod` call is a no-op; that's a known limitation
 * of Node's fs API on NTFS. Remote mode on Windows should be
 * considered best-effort until we wire a DPAPI-backed backend.
 */
export function saveRemoteConfig(cfg: RemoteConfig): void {
  ensureHomeDir()
  const tmp = `${CCCOLLAB_CONFIG_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // chmod failed (probably Windows); tolerate - the mode arg above
    // already covers POSIX.
  }
  renameSync(tmp, CCCOLLAB_CONFIG_FILE)
}

/**
 * Delete the remote config file (if present). Used by a future
 * `sign-out` flow and by tests that want a clean slate.
 */
export function clearRemoteConfig(): void {
  if (existsSync(CCCOLLAB_CONFIG_FILE)) {
    unlinkSync(CCCOLLAB_CONFIG_FILE)
  }
}

function readFile(): RemoteConfig | null {
  if (!existsSync(CCCOLLAB_CONFIG_FILE)) return null
  try {
    const raw = readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as Record<string, unknown>
    // Accept either the new `remoteUrl` or the legacy `hostedUrl`
    // field. Any other shape is rejected as "no config".
    const urlRaw =
      typeof obj.remoteUrl === 'string' ? obj.remoteUrl : typeof obj.hostedUrl === 'string' ? obj.hostedUrl : undefined
    if (urlRaw === undefined) return null
    return {
      remoteUrl: urlRaw,
      accessToken: typeof obj.accessToken === 'string' ? obj.accessToken : '',
      refreshToken: typeof obj.refreshToken === 'string' ? obj.refreshToken : '',
      userEmail: typeof obj.userEmail === 'string' ? obj.userEmail : undefined,
      userId: typeof obj.userId === 'string' ? obj.userId : undefined,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
    }
  } catch {
    // Corrupt file: treat as "no config". A future iteration could
    // rename the bad file aside for forensics instead of silently
    // ignoring.
    return null
  }
}

function ensureHomeDir(): void {
  mkdirSync(CCCOLLAB_HOME, { recursive: true })
  const parent = dirname(CCCOLLAB_CONFIG_FILE)
  mkdirSync(parent, { recursive: true })
}
