/**
 * Email allow-list for Convex Auth sign-in.
 *
 * Centralised so the policy is testable as a pure function, independent of
 * the Convex Auth callback plumbing in `convex/auth.ts`. Adding a new
 * accepted domain here is the only change needed to extend the allow-list.
 *
 * Domains are compared case-insensitively. Leading/trailing whitespace in
 * the stored list would be a bug; keep entries lowercase and trimmed.
 */

export const ALLOWED_EMAIL_DOMAINS: readonly string[] = ['flatout.solutions']

/**
 * Extract the domain portion of an email address in lowercase. Returns an
 * empty string for input without an `@`, including non-string inputs that
 * upstream code should have rejected.
 */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 0) return ''
  return email.slice(at + 1).toLowerCase()
}

/**
 * True if `email` is a non-empty string whose domain is in
 * `ALLOWED_EMAIL_DOMAINS`. Narrows `email` to `string` on success so
 * callers can use the value directly after the check.
 */
export function isAllowedEmail(email: string | undefined | null): email is string {
  if (typeof email !== 'string' || email.length === 0) return false
  const domain = emailDomain(email)
  if (domain.length === 0) return false
  return ALLOWED_EMAIL_DOMAINS.includes(domain)
}
