import type { ChannelLocation, Transport } from './index.js'

/**
 * Per-call routing of tool operations across the set of enabled
 * transports.
 *
 * Every tool handler that used to receive a single `Transport` now
 * receives a `TransportRouter`. Rules:
 *
 * - Channel-addressed ops (`join_channel`, `leave_channel`,
 *   `send_message_to_channel`, `set_active_channel`, `list_topics`
 *   scoped to a channel, `start_topic`) pick a transport via
 *   `getByLocation(args.location ?? 'local')`. Default is `'local'`.
 *
 * - Topic-addressed ops (`join_topic` by id, `leave_topic`,
 *   `archive_topic`, `unarchive_topic`, `send_message_to_topic`) pick a
 *   transport by asking each enabled transport `hasTopic(topicId)` and
 *   dispatching to the one that owns it.
 *
 * - List ops (`list_channels`, `list_sessions`, `list_topics` without a
 *   channel) iterate across every enabled transport via `enabled()`
 *   and the tool layer merges the results, tagging each row with its
 *   `location`.
 *
 * - Session-addressed ops (`send_message_to_session`) prefer the local
 *   transport when both know the recipient; see
 *   `src/tools/topics.ts` for the exact routing.
 *
 * The router is a thin wrapper over an array of transports. It does
 * NOT own any transport lifecycle state - the array is constructed
 * once at startup in `server.ts` and passed into the tool layer. A
 * transport that has flipped `enabled = false` via graceful
 * degradation is still in the array but will be skipped by
 * `enabled()` and refused by `getByLocation` / `getByTopicId` with a
 * structured error.
 */
export class TransportRouter {
  private readonly transports: Transport[]

  constructor(transports: Transport[]) {
    this.transports = transports
  }

  /** Every enabled transport, in construction order. */
  enabled(): Transport[] {
    return this.transports.filter((t) => t.enabled)
  }

  /** The full list, including disabled transports. Used rarely: e.g.
   *  for shutdown hooks that must still call `deregisterSession` on
   *  transports that self-disabled. */
  all(): Transport[] {
    return [...this.transports]
  }

  /** Is the remote transport configured and currently enabled? Used by
   *  `whoami` to surface the "remote sync is off" status when graceful
   *  degradation has tripped. */
  hasRemote(): boolean {
    return this.transports.some((t) => t.source === 'remote' && t.enabled)
  }

  /** Is the remote transport configured at all (regardless of enabled
   *  state)? `true` when the session started with remote credentials,
   *  even if the transport has since self-disabled. */
  hasRemoteConfigured(): boolean {
    return this.transports.some((t) => t.source === 'remote')
  }

  /**
   * Return the transport for the given channel location, or throw a
   * user-facing error if that transport isn't available. Called by
   * every channel-addressed tool.
   */
  getByLocation(location: ChannelLocation): Transport {
    const match = this.transports.find((t) => t.source === location)
    if (match === undefined) {
      throw new Error(
        location === 'remote'
          ? 'Remote mode is not configured. Call the `authenticate` tool to sign in, or set CCCOLLAB_REMOTE_URL.'
          : 'Local broker is not available.',
      )
    }
    if (!match.enabled) {
      throw new Error(
        location === 'remote'
          ? 'Remote sync is degraded for this session. Restart your Claude Code session (or re-authenticate) to restore it.'
          : 'Local transport is disabled.',
      )
    }
    return match
  }

  /**
   * Return the transport that owns a given topic id, by asking each
   * enabled transport `hasTopic`. Throws if none claim ownership - the
   * tool layer surfaces that as a "topic not found" error to the caller.
   *
   * When both transports claim the id (can't happen in practice given
   * disjoint id spaces, but the interface permits it) we prefer
   * `'local'` to match the dedup-friendly routing used for DMs.
   */
  getByTopicId(topicId: string): Transport {
    const enabled = this.enabled()
    const owners = enabled.filter((t) => t.hasTopic(topicId))
    if (owners.length === 0) {
      throw new Error(`No transport owns topic id "${topicId}".`)
    }
    if (owners.length > 1) {
      const local = owners.find((t) => t.source === 'local')
      if (local) return local
    }
    return owners[0]!
  }
}
