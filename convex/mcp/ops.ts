import { ConvexError, v } from 'convex/values'

import type { Doc, Id } from '../_generated/dataModel'
import { internalMutation, internalQuery } from '../_generated/server'
import { nowMs } from '../lib/time'

/**
 * Internal operations behind the MCP tools.
 *
 * The `/mcp` HTTP action has already authenticated the caller via Bearer
 * token and resolved (`userId`, `sessionId`). These functions take those
 * as explicit args so they don't need Convex Auth context — MCP clients
 * sign with OAuth 2.1 tokens issued by our authorization server, not with
 * Convex Auth JWTs. The MCP bearer token effectively delegates a subset of
 * the user's cccollab access to an AI client; these ops enforce that
 * subset against the same underlying tables Stefan's public mutations use.
 *
 * Scope rule: the AI can only read / write where the underlying human user
 * has channel-level membership. "The AI cannot exceed the authorizing user."
 */

export const listTopicsForUser = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }): Promise<Doc<'topics'>[]> => {
    const channelMembers = await ctx.db
      .query('channelMembers')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    const out: Doc<'topics'>[] = []
    for (const cm of channelMembers) {
      const topics = await ctx.db
        .query('topics')
        .withIndex('by_channel', (q) => q.eq('channelId', cm.channelId))
        .collect()
      for (const t of topics) {
        if (t.state === 'active') out.push(t)
      }
    }
    return out
  },
})

/** Max messages returned by `read_topic` so MCP responses stay bounded. */
export const READ_TOPIC_MESSAGE_CAP = 200

export const readTopicForUser = internalQuery({
  args: { userId: v.id('users'), topicId: v.id('topics') },
  handler: async (ctx, { userId, topicId }): Promise<{ topic: Doc<'topics'>; messages: Doc<'messages'>[] } | null> => {
    const topic = await ctx.db.get(topicId)
    if (!topic || topic.state !== 'active') return null
    const cm = await ctx.db
      .query('channelMembers')
      .withIndex('by_user_and_channel', (q) => q.eq('userId', userId).eq('channelId', topic.channelId))
      .unique()
    if (!cm) return null
    // `.order('desc').take(N)` gives us the newest N; return oldest-first
    // so the MCP client sees history in chronological order.
    const newest = await ctx.db
      .query('messages')
      .withIndex('by_topic_and_ts', (q) => q.eq('topicId', topicId))
      .order('desc')
      .take(READ_TOPIC_MESSAGE_CAP)
    return { topic, messages: newest.reverse() }
  },
})

export const sendMessageToTopicFromMcp = internalMutation({
  args: {
    userId: v.id('users'),
    sessionId: v.id('sessions'),
    topicId: v.id('topics'),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'messages'>> => {
    if (!args.text.trim()) {
      throw new ConvexError({ code: 'INVALID_REQUEST', message: 'text must not be empty' })
    }
    const session = await ctx.db.get(args.sessionId)
    if (!session || session.userId !== args.userId) {
      throw new ConvexError({ code: 'INVALID_SESSION', message: 'session does not belong to user' })
    }
    const topic = await ctx.db.get(args.topicId)
    if (!topic || topic.state !== 'active') {
      throw new ConvexError({ code: 'TOPIC_NOT_FOUND', message: 'topic not found or not active' })
    }
    const cm = await ctx.db
      .query('channelMembers')
      .withIndex('by_user_and_channel', (q) => q.eq('userId', args.userId).eq('channelId', topic.channelId))
      .unique()
    if (!cm) {
      throw new ConvexError({
        code: 'NOT_CHANNEL_MEMBER',
        message: "user is not a member of the topic's channel",
      })
    }
    // Ensure the synthetic session has a topicMembers row. Auto-join on first
    // send is reasonable here: the user has channel membership + OAuth granted
    // topics.rw to this AI client; forcing a separate `join_topic` MCP tool
    // round-trip adds friction without adding security.
    const tm = await ctx.db
      .query('topicMembers')
      .withIndex('by_topic_and_session', (q) => q.eq('topicId', args.topicId).eq('sessionId', args.sessionId))
      .unique()
    if (!tm) {
      await ctx.db.insert('topicMembers', {
        topicId: args.topicId,
        sessionId: args.sessionId,
        joinedAt: nowMs(),
      })
    }
    return await ctx.db.insert('messages', {
      kind: 'topic',
      topicId: args.topicId,
      channelId: topic.channelId,
      fromSessionId: args.sessionId,
      fromUserId: args.userId,
      text: args.text,
      ts: nowMs(),
    })
  },
})
