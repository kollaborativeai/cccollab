import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface InitialIdentity {
  name?: string
  objective?: string
}

export const IDENTITY_FILE_NAME = '.cccollab.json'

/**
 * Resolve an initial session identity from (in precedence order):
 *   1. CCCOLLAB_NAME / CCCOLLAB_OBJECTIVE env vars
 *   2. A .cccollab.json file found by walking up from cwd
 *
 * If neither source is present, returns {} and the LLM must call `introduce`.
 * The env lookup and file read are both failure-tolerant: malformed JSON
 * or unreadable files are ignored with a warning so a bad config never
 * prevents the MCP server from starting.
 */
export function resolveInitialIdentity(cwd: string, env: NodeJS.ProcessEnv = process.env): InitialIdentity {
  const envName = trimOrUndefined(env.CCCOLLAB_NAME)
  const envObjective = trimOrUndefined(env.CCCOLLAB_OBJECTIVE)
  if (envName || envObjective) {
    return { name: envName, objective: envObjective }
  }

  const fromFile = readIdentityFile(cwd)
  if (fromFile) return fromFile

  return {}
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readIdentityFile(startDir: string): InitialIdentity | undefined {
  let dir = path.resolve(startDir)
  // Walk up until we find the file or hit the filesystem root.
  while (true) {
    const candidate = path.join(dir, IDENTITY_FILE_NAME)
    try {
      const raw = readFileSync(candidate, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') {
        console.error(`[cccollab] ${candidate} is not a JSON object, ignoring`)
        return undefined
      }
      const record = parsed as Record<string, unknown>
      const name = typeof record.name === 'string' ? trimOrUndefined(record.name) : undefined
      const objective = typeof record.objective === 'string' ? trimOrUndefined(record.objective) : undefined
      if (!name && !objective) return undefined
      return { name, objective }
    } catch (err) {
      // ENOENT: keep walking. Any other error: log and abort walk.
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
