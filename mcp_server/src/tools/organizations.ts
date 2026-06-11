import type { TransportRouter } from '../transport/router.js'

export interface OrganizationToolDeps {
  router: TransportRouter
  /** Bring dormant token-bearing locations online before enumerating, so a
   *  remote in config is queried without a fresh `authenticate`. Optional so
   *  legacy unit tests keep compiling. See `ensureLazyAttach`. */
  ensureAttached?: (target?: string, opts?: { force?: boolean }) => Promise<void>
}

/** A transport that can list organizations (remote transports only). */
interface OrgCapableTransport {
  source: string
  listOrganizations(): Promise<Array<{ id: string; name: string }>>
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
 */
export async function handleListOrganizations(deps: OrganizationToolDeps): Promise<string> {
  await deps.ensureAttached?.()
  const organizations: Array<{ id: string; name: string; location: string }> = []
  for (const transport of deps.router.enabled()) {
    if (!canListOrganizations(transport)) continue
    try {
      const rows = await transport.listOrganizations()
      for (const row of rows) {
        organizations.push({ id: row.id, name: row.name, location: transport.source })
      }
    } catch {
      // Transport unreachable — skip it.
    }
  }
  return JSON.stringify({ organizations })
}
