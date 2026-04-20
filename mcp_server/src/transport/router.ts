import { LOCAL_LOCATION, type ChannelLocation, type Transport } from './index.js'

/**
 * Per-call routing of tool operations across the set of enabled
 * transports. The router owns a `Map<locationName, Transport>` - the
 * set of names is whatever the resolved config declared under
 * `locations`, plus the always-present `"local"`.
 *
 * Every tool handler that used to pick a single transport now picks
 * by location name via `get(name)` or by topic id via `getByTopicId`.
 * List tools iterate `enabled()` and union the results, tagging each
 * row with its source location name.
 *
 * The router is a thin façade over the map. It does NOT own any
 * transport lifecycle state - the map is constructed once at startup
 * in `server.ts`. A transport that has flipped `enabled = false` via
 * graceful degradation is still in the map but will be skipped by
 * `enabled()` and refused by `get` / `getByTopicId` with a structured
 * error.
 */
export class TransportRouter {
  private readonly transports: Map<string, Transport>

  constructor(transports: Iterable<Transport> | Map<string, Transport>) {
    if (transports instanceof Map) {
      this.transports = new Map(transports)
    } else {
      this.transports = new Map()
      for (const t of transports) {
        if (this.transports.has(t.source)) {
          throw new Error(`TransportRouter: duplicate location name "${t.source}".`)
        }
        this.transports.set(t.source, t)
      }
    }
  }

  /** Every enabled transport, in map insertion order. */
  enabled(): Transport[] {
    return [...this.transports.values()].filter((t) => t.enabled)
  }

  /** The full list, including disabled transports. Used for shutdown
   *  hooks that must still call `deregisterSession` on transports that
   *  self-disabled. */
  all(): Transport[] {
    return [...this.transports.values()]
  }

  /** Is a location with the given name configured? Enabled state does
   *  not affect this - a degraded transport still counts as configured. */
  has(name: string): boolean {
    return this.transports.has(name)
  }

  /** All configured location names, in insertion order. */
  names(): string[] {
    return [...this.transports.keys()]
  }

  /** Is any non-local transport enabled? Used by `server.ts` to decide
   *  whether to add the "remote mode is active" line to the MCP
   *  instructions block. */
  hasRemote(): boolean {
    for (const t of this.transports.values()) {
      if (t.source !== LOCAL_LOCATION && t.enabled) return true
    }
    return false
  }

  /** Is any non-local transport configured (regardless of enabled
   *  state)? Mirrors `hasRemote` but for `whoami`-style reporting that
   *  should still surface a configured-but-degraded state. */
  hasRemoteConfigured(): boolean {
    for (const t of this.transports.values()) {
      if (t.source !== LOCAL_LOCATION) return true
    }
    return false
  }

  /**
   * Return the transport for the given location name, or throw a
   * user-facing error. Disabled transports surface a distinct message
   * so the caller can distinguish "never configured" from "degraded".
   */
  get(location: ChannelLocation): Transport {
    const match = this.transports.get(location)
    if (match === undefined) {
      const known = this.names().join(', ')
      throw new Error(`Location "${location}" is not configured. Configured locations: ${known}.`)
    }
    if (!match.enabled) {
      throw new Error(
        match.source === LOCAL_LOCATION
          ? 'Local transport is disabled.'
          : `Location "${location}" is degraded for this session. Restart your Claude Code session (or re-authenticate) to restore it.`,
      )
    }
    return match
  }

  /**
   * Return the transport that owns a given topic id, by asking each
   * enabled transport `hasTopic`. Throws if none claim ownership - the
   * tool layer surfaces that as a "topic not found" error to the caller.
   *
   * When multiple transports claim the id (can't happen in practice
   * given disjoint id spaces, but the interface permits it) prefer
   * the first enabled one in insertion order. The router's caller
   * constructs transports in a deterministic order so the tie-break
   * is stable across runs.
   */
  getByTopicId(topicId: string): Transport {
    const enabled = this.enabled()
    const owners = enabled.filter((t) => t.hasTopic(topicId))
    if (owners.length === 0) {
      throw new Error(`No transport owns topic id "${topicId}".`)
    }
    return owners[0]!
  }
}
