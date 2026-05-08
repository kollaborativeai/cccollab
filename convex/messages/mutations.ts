import { v, ConvexError } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { authenticatedMutation, type AuthenticatedMutationCtx } from '../utils/auth'
import { assertSessionOwnedByCaller } from '../sessions/mutations'
import { assertCallerSubscribedToChannel, requireTopic } from '../topics/helpers'
import { requireNormalizedChannelName } from '../channels/helpers'

/**
 * Allocate a strictly monotonic `ts` for a new message in this channel.
 *
 * Rationale: the per-session ack cursor (`channelReadCursors`) uses
 * `ts` as its high-water-mark and filters with strict `>`. Two
 * `Date.now()` calls in the same millisecond would produce identical
 * `ts` values and cause a cursor set to the earlier message's `ts` to
 * drop BOTH on the next subscribe. Returning `max(now, latestTs + 1)`
 * guarantees every message in a channel has a unique, monotonically
 * increasing `ts` so the cursor can always point unambiguously at "the
 * last message I delivered". The extra +1 drift is bounded by the burst
 * rate and self-corrects once writes slow down.
 */
async function allocateChannelTs(ctx: AuthenticatedMutationCtx, channelId: Id<'channels'>): Promise<number> {
  const latest = await ctx.db
    .query('messages')
    .withIndex('by_channel_and_ts', (q) => q.eq('channelId', channelId))
    .order('desc')
    .first()
  const now = Date.now()
  if (latest === null) return now
  return now > latest.ts ? now : latest.ts + 1
}

/**
 * Send a message inside a topic.
 *
 * Mirrors broker's `POST /topics/:id/messages`. The caller's session must
 * own the topic membership - broadcasting into topics you haven't joined is
 * how the broker treats an `Error: Not subscribed` for a "message sent to
 * wrong topic" situation.
 */
export const sendToTopic = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    topicId: v.id('topics'),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    requireNonEmpty(args.text)
    const session = await assertSessionOwnedByCaller(ctx, args.sessionId)
    const topic = await requireTopic(ctx, args.topicId)
    await assertCallerSubscribedToChannel(ctx, topic.channelId)

    const membership = await ctx.db
      .query('topicMembers')
      .withIndex('by_topic_and_session', (q) => q.eq('topicId', topic._id).eq('sessionId', session._id))
      .unique()
    if (membership === null) {
      throw new ConvexError({
        code: 'NOT_IN_TOPIC',
        message: 'You must join the topic before sending messages to it.',
      })
    }

    const messageId = await ctx.db.insert('messages', {
      kind: 'topic',
      topicId: topic._id,
      channelId: topic.channelId, // denormalised per messages/schema.ts
      fromSessionId: session._id,
      fromUserId: ctx.userId,
      text: args.text,
      ts: await allocateChannelTs(ctx, topic.channelId),
    })
    return { messageId, topicId: topic._id }
  },
})

/** Top-level broadcast into a channel; the caller's session must be present there. */
export const sendToChannel = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    channel: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    requireNonEmpty(args.text)
    const session = await assertSessionOwnedByCaller(ctx, args.sessionId)
    const normalized = requireNormalizedChannelName(args.channel)
    const channel = await ctx.db
      .query('channels')
      .withIndex('by_normalizedName', (q) => q.eq('normalizedName', normalized))
      .unique()
    if (channel === null) {
      throw new ConvexError({ code: 'CHANNEL_NOT_FOUND', message: `No channel "${args.channel}".` })
    }
    await assertCallerSubscribedToChannel(ctx, channel._id)

    const messageId = await ctx.db.insert('messages', {
      kind: 'broadcast',
      channelId: channel._id,
      fromSessionId: session._id,
      fromUserId: ctx.userId,
      text: args.text,
      ts: await allocateChannelTs(ctx, channel._id),
    })
    return { messageId, channelId: channel._id }
  },
})

/**
 * Direct message to another session. Mirrors the broker's DM semantics:
 * - Sender and recipient must share at least one channel.
 * - `toSessionName` is NOT globally unique (two users could each name a
 *   session "architect") so we resolve name→session at mutation time by
 *   filtering candidates to those sharing a channel with the sender. The
 *   happy path has exactly one candidate; the error cases are:
 *   - `DM_RECIPIENT_NOT_FOUND` - no matching session.
 *   - `DM_RECIPIENT_AMBIGUOUS` - more than one session of that name shares
 *     a channel with the sender; client must disambiguate by session id.
 *
 * The shared channel used to route the DM is persisted on the message row
 * (`channelId`) for future display / auditing; routing is NOT constrained
 * by this column on subsequent reads.
 */
export const sendToSession = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    // Accept EITHER an explicit recipient id (preferred when caller has it)
    // or a name string (for the common `send_message_to_session` MCP tool).
    toSessionId: v.optional(v.id('sessions')),
    toSessionName: v.optional(v.string()),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    requireNonEmpty(args.text)
    const session = await assertSessionOwnedByCaller(ctx, args.sessionId)

    const recipient: Doc<'sessions'> = await resolveRecipient(ctx, session._id, args)

    // Sender and recipient must share at least one channel. The caller
    // supplies the sender session id; we look up both sides' presence and
    // intersect. This mirrors the broker's behaviour where a DM is only
    // deliverable if the two sessions are tuned to a common channel.
    const sharedChannelId = await firstSharedChannelId(ctx, session._id, recipient._id)
    if (sharedChannelId === null) {
      throw new ConvexError({
        code: 'DM_NO_SHARED_CHANNEL',
        message: 'You do not share any channel with the recipient. Join a common channel first.',
      })
    }

    const messageId = await ctx.db.insert('messages', {
      kind: 'direct',
      channelId: sharedChannelId,
      fromSessionId: session._id,
      fromUserId: ctx.userId,
      toSessionId: recipient._id,
      text: args.text,
      ts: await allocateChannelTs(ctx, sharedChannelId),
    })
    return { messageId, toSessionId: recipient._id, viaChannelId: sharedChannelId }
  },
})

// ─── helpers ─────────────────────────────────────────────────────────────

function requireNonEmpty(text: string): void {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ConvexError({ code: 'INVALID_TEXT', message: '`text` must be a non-empty string.' })
  }
}

async function resolveRecipient(
  ctx: AuthenticatedMutationCtx,
  senderSessionId: Id<'sessions'>,
  args: { toSessionId?: Id<'sessions'>; toSessionName?: string },
): Promise<Doc<'sessions'>> {
  if (args.toSessionId !== undefined) {
    if (args.toSessionId === senderSessionId) {
      // Mirror the by-name self-skip: a session can't DM itself.
      // `firstSharedChannelId` would otherwise return a hit (every
      // session shares channels with itself) and the message would be
      // written successfully, which is non-sensical.
      throw new ConvexError({
        code: 'DM_RECIPIENT_NOT_FOUND',
        message: 'Cannot send a direct message to your own session.',
      })
    }
    const byId = await ctx.db.get(args.toSessionId)
    if (byId === null) {
      throw new ConvexError({ code: 'DM_RECIPIENT_NOT_FOUND', message: `No session ${args.toSessionId}.` })
    }
    return byId
  }
  if (args.toSessionName !== undefined) {
    return await resolveRecipientByName(ctx, senderSessionId, args.toSessionName)
  }
  throw new ConvexError({
    code: 'DM_RECIPIENT_REQUIRED',
    message: 'Provide either toSessionId or toSessionName.',
  })
}

async function resolveRecipientByName(
  ctx: AuthenticatedMutationCtx,
  senderSessionId: Id<'sessions'>,
  toSessionName: string,
): Promise<Doc<'sessions'>> {
  const name = toSessionName.trim()
  if (name.length === 0) {
    throw new ConvexError({
      code: 'INVALID_RECIPIENT_NAME',
      message: 'Recipient session name must be a non-empty string.',
    })
  }
  const byName = await ctx.db
    .query('sessions')
    .withIndex('by_sessionName', (q) => q.eq('sessionName', name))
    .collect()

  // Filter to sessions sharing at least one channel with the sender.
  const sharing: Doc<'sessions'>[] = []
  for (const candidate of byName) {
    if (candidate._id === senderSessionId) continue
    const shared = await firstSharedChannelId(ctx, senderSessionId, candidate._id)
    if (shared !== null) sharing.push(candidate)
  }

  if (sharing.length === 0) {
    throw new ConvexError({
      code: 'DM_RECIPIENT_NOT_FOUND',
      message: `No session named "${name}" shares a channel with you.`,
    })
  }
  if (sharing.length > 1) {
    throw new ConvexError({
      code: 'DM_RECIPIENT_AMBIGUOUS',
      message: `More than one session named "${name}" shares a channel with you. Specify toSessionId.`,
      candidateSessionIds: sharing.map((s) => s._id),
    })
  }
  const only = sharing[0]
  if (only === undefined) {
    throw new ConvexError({ code: 'INTERNAL', message: 'Unexpected empty recipient candidate array.' })
  }
  return only
}

/**
 * Bump the per-session-per-channel delivery cursor ("ack").
 *
 * Called by a session's MCP server after it has delivered a batch of
 * channel broadcasts up to and including `ts` to its caller, so the next
 * `listByChannel({sessionId, channelId})` subscribe returns strictly
 * greater `ts` rows. Prevents the full-channel-backlog replay that would
 * otherwise hit the MCP notification stream on every process restart.
 *
 * Guarantees:
 *   - Monotonic: regressing `ts` below the stored cursor is a no-op.
 *   - Owner-only: the caller must own `sessionId`; attempting to bump
 *     another user's cursor throws `ACK_SESSION_NOT_OWNED`. This matches
 *     the `listDirectMessagesForSession` auth-leak pattern.
 *   - Idempotent: repeated acks of the same `ts` don't error.
 *
 * Failure mode: if the Convex deployment's table is wiped, cursors are
 * lost and clients see the full channel backlog on their next subscribe.
 * Accepted tradeoff - this is rare and the resulting duplicates are
 * Claude-visible but non-destructive.
 */
export const ackChannel = authenticatedMutation({
  args: {
    sessionId: v.id('sessions'),
    channelId: v.id('channels'),
    ts: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId)
    if (session === null || session.userId !== ctx.userId) {
      throw new ConvexError({
        code: 'ACK_SESSION_NOT_OWNED',
        message: 'Session is not owned by the calling user.',
      })
    }
    // Cursor is keyed by (userId, sessionName, channelId) - see
    // `channelReadCursorsTable` docs. The sessionId arg is used only to
    // (a) authorize the caller, and (b) look up the stable sessionName.
    const existing = await ctx.db
      .query('channelReadCursors')
      .withIndex('by_user_and_sessionName_and_channel', (q) =>
        q.eq('userId', ctx.userId).eq('sessionName', session.sessionName).eq('channelId', args.channelId),
      )
      .unique()
    const now = Date.now()
    if (existing === null) {
      await ctx.db.insert('channelReadCursors', {
        userId: ctx.userId,
        sessionName: session.sessionName,
        channelId: args.channelId,
        lastDeliveredTs: args.ts,
        updatedAt: now,
      })
      return
    }
    if (args.ts > existing.lastDeliveredTs) {
      await ctx.db.patch(existing._id, { lastDeliveredTs: args.ts, updatedAt: now })
    }
  },
})

async function firstSharedChannelId(
  ctx: AuthenticatedMutationCtx,
  leftSessionId: Id<'sessions'>,
  rightSessionId: Id<'sessions'>,
): Promise<Id<'channels'> | null> {
  const left = await ctx.db
    .query('sessionChannels')
    .withIndex('by_session', (q) => q.eq('sessionId', leftSessionId))
    .collect()
  const leftSet = new Set<Id<'channels'>>(left.map((r) => r.channelId))

  const right = await ctx.db
    .query('sessionChannels')
    .withIndex('by_session', (q) => q.eq('sessionId', rightSessionId))
    .collect()
  for (const row of right) {
    if (leftSet.has(row.channelId)) return row.channelId
  }
  return null
}
