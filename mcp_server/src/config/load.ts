import { existsSync, readFileSync } from 'node:fs'
import { cosmiconfigSync } from 'cosmiconfig'

import { CccollabConfigSchema, type CccollabConfig } from './schema.js'
import { CCCOLLAB_CONFIG_FILE } from '../constants.js'

/**
 * Read the user-level `~/.cccollab/config.json` (the path held in
 * `CCCOLLAB_CONFIG_FILE`). Returns `{}` when the file is absent or
 * unreadable; malformed JSON and schema violations are surfaced as
 * errors so a broken user-level file is never silently ignored.
 */
export function loadUserConfig(): CccollabConfig {
  if (!existsSync(CCCOLLAB_CONFIG_FILE)) return {}
  const raw = readFileSync(CCCOLLAB_CONFIG_FILE, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `cccollab: ${CCCOLLAB_CONFIG_FILE} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  try {
    return CccollabConfigSchema.parse(parsed)
  } catch (err) {
    throw new Error(
      `cccollab: ${CCCOLLAB_CONFIG_FILE} failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

/** Filename searched for by `loadProjectConfig`. */
export const PROJECT_CONFIG_FILENAME = '.cccollab.json'

export interface ProjectConfigResult {
  config: CccollabConfig
  /** Absolute path of the discovered file, for use in credential-stripping
   *  warnings. `null` when no project-level config was found. */
  filePath: string | null
}

/**
 * Walk up from `cwd` looking for `.cccollab.json`. Uses `cosmiconfig`
 * so the walk-up behaviour, caching, and stop-at-package.json rules
 * match the ecosystem convention.
 *
 * Returns an empty config when no file is found. Malformed JSON and
 * schema violations are surfaced as errors so a broken project-level
 * file is never silently ignored.
 */
export function loadProjectConfig(cwd: string): ProjectConfigResult {
  const explorer = cosmiconfigSync('cccollab', {
    searchPlaces: [PROJECT_CONFIG_FILENAME],
    stopDir: '/',
  })
  const result = explorer.search(cwd)
  if (result === null || result.isEmpty) return { config: {}, filePath: null }

  try {
    const parsed = CccollabConfigSchema.parse(result.config as unknown)
    return { config: parsed, filePath: result.filepath }
  } catch (err) {
    throw new Error(
      `cccollab: ${result.filepath} failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}
