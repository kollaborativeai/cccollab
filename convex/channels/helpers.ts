import { ConvexError } from 'convex/values'

/**
 * Normalise a channel name the way the local broker does:
 * trim + lowercase. Returns `null` if the result is empty.
 *
 * Kept identical to `normalizeChannel` in `mcp_server/src/broker.ts` so
 * channels created through either transport collide correctly on the
 * same backend row.
 */
export function normalizeChannelName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * As above, but throws `INVALID_CHANNEL_NAME` ConvexError when the input
 * is empty / non-string. Use this at mutation boundaries where the caller
 * MUST have supplied a valid name.
 */
export function requireNormalizedChannelName(raw: unknown): string {
  const normalized = normalizeChannelName(raw)
  if (normalized === null) {
    throw new ConvexError({
      code: 'INVALID_CHANNEL_NAME',
      message: 'Channel name must be a non-empty string.',
    })
  }
  return normalized
}
