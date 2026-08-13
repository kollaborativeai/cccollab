import type { Transport } from './index.js'
import type { RemoteTransport } from './remote.js'

/**
 * The single place a transport's health is read.
 *
 * Two tools report per-location health — `whoami` (`tools/identity.ts`) and
 * `list_locations` (`tools/locations.ts`) — and each used to hand-roll its own
 * read of the transport's fields. That is why KAI-516's `partialDegradation`
 * reached one of them and not the other: `whoami` was taught to merge the new
 * signal, `list_locations` still read `degradation` alone, and so it reported a
 * clean bill of health for a location that had gone quietly incomplete
 * (cc#41 FINDING-41a).
 *
 * Fixing the reader rather than the field is deliberate. Un-merging
 * `partialDegradation` back out of `degradation` would have made
 * `list_locations` obviously blind instead of quietly blind — it still would
 * not have reported it. Two independent readers was the cause; one reader is
 * the fix, and the next health fact added here reaches both by construction.
 *
 * A self-disable OUTRANKS a reduced capability: the location is not "answering,
 * but quietly incomplete", it is off, and that is the actionable fact. Callers
 * that need to tell the two apart read `enabled` alongside it — a degraded
 * *enabled* transport is the partial case, a degraded disabled one is not.
 *
 * Duck-typed on purpose: `LocalTransport` exposes `degradation` and no
 * `partialDegradation`, and neither is on the `Transport` interface.
 */
export function transportHealth(transport: Transport): { enabled: boolean; degradation?: string } {
  const maybeDegraded = transport as Partial<RemoteTransport>
  const degradation =
    (typeof maybeDegraded.degradation === 'string' ? maybeDegraded.degradation : null) ??
    (typeof maybeDegraded.partialDegradation === 'string' ? maybeDegraded.partialDegradation : null)
  return { enabled: transport.enabled, ...(degradation ? { degradation } : {}) }
}
