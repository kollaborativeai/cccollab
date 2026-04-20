import { v, ConvexError } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { authenticatedMutation, type AuthenticatedMutationCtx } from '../utils/auth'
import { assertSessionOwnedByCaller } from '../sessions/mutations'
import { assertCallerSubscribedToChannel, requireTopic } from '../topics/helpers'
import { requireNormalizedChannelName } from '../channels/helpers'

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
      ts: Date.now(),
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
      ts: Date.now(),
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
      ts: Date.now(),
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
