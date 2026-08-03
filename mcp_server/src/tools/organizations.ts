import type { TransportRouter } from '../transport/router.js'

export interface OrganizationToolDeps {
  router: TransportRouter
  /** Bring dormant token-bearing locations online before enumerating, so a
   *  remote in config is queried without a fresh `authenticate`. Optional so
   *  legacy unit tests keep compiling. See `ensureLazyAttach`. */
  ensureAttached?: (target?: string, opts?: { force?: boolean; allowWithoutName?: boolean }) => Promise<void>
}

/** A transport that can list organizations (remote transports only). */
interface OrgCapableTransport {
  source: string
  listOrganizations(): Promise<Array<{ id: string; name: string; slug?: string }>>
}

function canListOrganizations(transport: unknown): transport is OrgCapableTransport {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as { listOrganizations?: unknown }).listOrganizations === 'function'
  )
}

/**
 * Lists the authenticated user's organizations across every enabled remote
 * transport. The local in-process broker is single-tenant and contributes
 * nothing. Callable before `introduce` — it is a read, not a session action.
 *
 * Because it is the pre-`introduce` discovery tool (you call it to pick an
 * org to introduce with), it attaches dormant remotes with
 * `allowWithoutName` so it works on a session that has not introduced yet —
 * lifting only the name gate, not the dedup/once-per-session guards.
 *
 * Each row carries the org's `slug` when it has one (KAI-407) — the readable
 * handle from the org's web URL, and the preferred value to pass to
 * `introduce`. Orgs that never got a slug are addressable by `id` only, so
 * the key is omitted rather than emitted empty.
 */
export async function handleListOrganizations(deps: OrganizationToolDeps): Promise<string> {
  await deps.ensureAttached?.(undefined, { allowWithoutName: true })
  const organizations: Array<{ id: string; name: string; slug?: string; location: string }> = []
  for (const transport of deps.router.enabled()) {
    if (!canListOrganizations(transport)) continue
    try {
      const rows = await transport.listOrganizations()
      for (const row of rows) {
        organizations.push({
          id: row.id,
          name: row.name,
          ...(row.slug ? { slug: row.slug } : {}),
          location: transport.source,
        })
      }
    } catch {
      // Transport unreachable — skip it.
    }
  }
  return JSON.stringify({ organizations })
}
