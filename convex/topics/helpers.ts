import { ConvexError } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import type { AuthenticatedMutationCtx, AuthenticatedQueryCtx } from '../utils/auth'

type AnyAuthCtx = AuthenticatedMutationCtx | AuthenticatedQueryCtx

/**
 * Load a topic by id or throw `TOPIC_NOT_FOUND`.
 *
 * Lives in a shared helpers module (not in `mutations.ts`) so it can be
 * called from both mutation and query contexts without a mutation-shaped
 * ctx type leaking into read-only call sites.
 */
export async function requireTopic<Ctx extends AnyAuthCtx>(ctx: Ctx, topicId: Id<'topics'>): Promise<Doc<'topics'>> {
  const topic = await ctx.db.get(topicId)
  if (topic === null) {
    throw new ConvexError({ code: 'TOPIC_NOT_FOUND', message: `No topic with id ${topicId}.` })
  }
  return topic
}

/**
 * Throw `NOT_SUBSCRIBED_TO_CHANNEL` unless the caller has a user-level
 * standing subscription to this channel. Shared across topics, messages,
 * and any future cross-channel helper.
 */
export async function assertCallerSubscribedToChannel<Ctx extends AnyAuthCtx>(
  ctx: Ctx,
  channelId: Id<'channels'>,
): Promise<void> {
  const membership = await ctx.db
    .query('channelMembers')
    .withIndex('by_user_and_channel', (q) => q.eq('userId', ctx.userId).eq('channelId', channelId))
    .unique()
  if (membership === null) {
    throw new ConvexError({
      code: 'NOT_SUBSCRIBED_TO_CHANNEL',
      message: 'Caller is not subscribed to this channel.',
    })
  }
}
