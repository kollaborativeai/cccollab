import deepmerge from 'deepmerge'

import { AUTH_FIELDS, type CccollabConfig, type LocationConfig, type UserCccollabConfig } from './schema.js'

/**
 * Merge a user-level config (from `~/.cccollab/config.json`) with a
 * project-level config (from `.cccollab.json` walked up from cwd). The
 * project value wins whenever both sides define the same scalar field;
 * maps (locations / channels / topics) are unioned by key.
 *
 * Deepmerge is sufficient here because our schema has no array fields -
 * every collection is a record keyed by name. If a field is added later
 * that holds an array, its merge semantics need to be decided
 * explicitly; guard with a targeted helper rather than silently picking
 * one of deepmerge's array strategies.
 */
export function mergeConfigs(user: UserCccollabConfig, project: CccollabConfig): UserCccollabConfig {
  return deepmerge(user, project, {
    // No arrays appear in the schema today; tripping this guard
    // indicates a schema change that needs explicit merge semantics.
    arrayMerge: () => {
      throw new Error(
        'cccollab config: unexpected array field; merge semantics must be declared explicitly (no array fields in schema).',
      )
    },
  }) as UserCccollabConfig
}

export interface StripCredentialsResult {
  stripped: CccollabConfig
  /** Number of locations that contained credentials. Callers can use
   *  this to make tests deterministic; `stripProjectCredentials` also
   *  emits one `console.error` per occurrence. */
  warnings: number
}

/**
 * Remove OAuth-related fields from every location in a project-level
 * config, emitting one `console.error` per location that carried any.
 * Credentials belong in the user-level file only - the project-level
 * file is typically checked into source control. A single shared
 * message is used so the warning is obvious and greppable.
 *
 * Does not mutate `input`; returns a fresh object.
 */
export function stripProjectCredentials(input: CccollabConfig, sourcePath: string): StripCredentialsResult {
  // Structured clone so the caller's object is never mutated.
  const copy = structuredClone(input) as CccollabConfig
  if (!copy.locations) {
    return { stripped: copy, warnings: 0 }
  }
  let warnings = 0
  for (const [locationName, location] of Object.entries(copy.locations)) {
    if (!location) continue
    const loc = location as LocationConfig
    let locHadCredentials = false
    for (const field of AUTH_FIELDS) {
      if (field in loc) {
        delete (loc as Record<string, unknown>)[field]
        locHadCredentials = true
      }
    }
    if (locHadCredentials) {
      warnings += 1
      console.error(
        `[cccollab] Credentials in project-level config are ignored; move them to ~/.cccollab/config.json (location "${locationName}" in ${sourcePath})`,
      )
    }
  }
  return { stripped: copy, warnings }
}
