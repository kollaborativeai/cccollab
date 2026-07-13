/**
 * One recorded attach failure: the location that failed and a
 * human-readable reason. Deliberately minimal — this is a status surface
 * (`whoami` / `list_locations`), not a log.
 */
export interface AttachFailure {
  location: string
  reason: string
}

/**
 * A diagnostics registry for *failed* transport attaches.
 *
 * The design split (KAI-368): the {@link TransportRouter} holds ONLY
 * healthy transports, so a bad remote never corrupts routing or the
 * "never leave a broken transport in the router" invariant that the
 * hot-attach (`authenticate`) path depends on. Attach failures live here
 * instead, so `whoami` can report `✗ personal  introduce failed: …`
 * without the failed transport ever entering the router.
 *
 * Keyed by location name; a later record for the same location overwrites
 * the earlier one (latest wins), and a successful attach `clear()`s the
 * entry so a resolved failure stops being surfaced.
 */
export class AttachDiagnostics {
  private readonly failures = new Map<string, AttachFailure>()

  /** Record (or overwrite) the failure for a location. */
  recordFailure(location: string, reason: string): void {
    this.failures.set(location, { location, reason })
  }

  /** Drop any recorded failure for a location (no-op if none). Called
   *  when the location subsequently attaches successfully. */
  clear(location: string): void {
    this.failures.delete(location)
  }

  /** The recorded failure for a location, or `undefined` when healthy. */
  get(location: string): AttachFailure | undefined {
    return this.failures.get(location)
  }

  /** Every recorded failure, in insertion order. */
  entries(): AttachFailure[] {
    return [...this.failures.values()]
  }
}
