/** The single scope used by CCC-22. Add to this list to expose more later. */
export const ALLOWED_SCOPES = ['cccollab:topics.rw'] as const
export type Scope = (typeof ALLOWED_SCOPES)[number]

/** Parse a space-separated scope string; return null if any scope is unknown
 *  or if the string is empty after trimming. */
export function parseScope(scope: string): Scope[] | null {
  const items = scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (items.length === 0) return null
  const allowed: Scope[] = []
  for (const item of items) {
    if (!(ALLOWED_SCOPES as readonly string[]).includes(item)) return null
    allowed.push(item as Scope)
  }
  return allowed
}

export function hasScope(tokenScope: string, required: Scope): boolean {
  const parsed = parseScope(tokenScope)
  return parsed !== null && parsed.includes(required)
}
