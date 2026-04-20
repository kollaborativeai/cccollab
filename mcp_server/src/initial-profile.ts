import { readFileSync } from 'node:fs'
import path from 'node:path'

export const PROFILE_FILE_NAME = '.cccollab.json'
const PROFILE_ENV_VAR = 'CCCOLLAB_PROFILE'
const FALLBACK_PROFILE = 'default'

/**
 * Resolve the collaboration profile for this session.
 *
 * Precedence:
 *   1. CCCOLLAB_PROFILE env var (trimmed; empty treated as absent)
 *   2. `profile` in .cccollab.json (walked up from cwd)
 *   3. Fallback to 'default'
 *
 * Malformed JSON or unreadable files are logged and treated as absent so a
 * bad config never prevents the MCP server from starting.
 */
export function resolveInitialProfile(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const envProfile = env[PROFILE_ENV_VAR]?.trim()
  if (envProfile) return envProfile

  const fromFile = readProfileFromFile(cwd)
  if (fromFile) return fromFile

  return FALLBACK_PROFILE
}

function readProfileFromFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir)
  while (true) {
    const candidate = path.join(dir, PROFILE_FILE_NAME)
    try {
      const raw = readFileSync(candidate, 'utf-8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        console.error(`[cccollab] ${candidate} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error(`[cccollab] ${candidate} is not a JSON object, ignoring`)
        return undefined
      }
      const record = parsed as Record<string, unknown>
      if (!('profile' in record)) return undefined
      const value = record.profile
      if (typeof value !== 'string') {
        console.error(`[cccollab] ${candidate} has non-string "profile", ignoring`)
        return undefined
      }
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code && code !== 'ENOENT') {
        console.error(`[cccollab] Failed to read ${candidate}: ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
    }

    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
