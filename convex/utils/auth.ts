import { getAuthUserId } from '@convex-dev/auth/server'
import { ConvexError } from 'convex/values'
import type { DefaultFunctionArgs } from 'convex/server'
import type { PropertyValidators } from 'convex/values'

import type { Id } from '../_generated/dataModel'
import { type MutationCtx, type QueryCtx, mutation, query } from '../_generated/server'

/**
 * Context passed to authenticated query/mutation handlers.
 *
 * `userId` is the Convex `Id<'users'>` of the signed-in user. Handlers that
 * need the user's profile should call `ctx.db.get(ctx.userId)` themselves;
 * most callers only need the userId as a foreign key and don't care about
 * the profile, so the helper skips that read by default.
 */
export type AuthenticatedQueryCtx = QueryCtx & { userId: Id<'users'> }
export type AuthenticatedMutationCtx = MutationCtx & { userId: Id<'users'> }

interface AuthenticatedQueryDefinition<Args extends DefaultFunctionArgs, Out> {
  args?: PropertyValidators
  handler: (ctx: AuthenticatedQueryCtx, args: Args) => Promise<Out> | Out
}

interface AuthenticatedMutationDefinition<Args extends DefaultFunctionArgs, Out> {
  args?: PropertyValidators
  handler: (ctx: AuthenticatedMutationCtx, args: Args) => Promise<Out> | Out
}

/**
 * Like `query`, but throws `UNAUTHENTICATED` when there is no signed-in user.
 * Handlers receive `ctx.userId: Id<'users'>`.
 */
export function authenticatedQuery<Args extends DefaultFunctionArgs, Out>(
  definition: AuthenticatedQueryDefinition<Args, Out>,
) {
  return query({
    args: definition.args ?? {},
    handler: async (ctx, args) => {
      const userId = await getAuthUserId(ctx)
      if (userId === null) {
        throw new ConvexError({ code: 'UNAUTHENTICATED', message: 'Sign-in required.' })
      }
      return definition.handler(Object.assign(ctx, { userId }), args as Args)
    },
  })
}

/**
 * Like `mutation`, but throws `UNAUTHENTICATED` when there is no signed-in
 * user. Handlers receive `ctx.userId: Id<'users'>`.
 */
export function authenticatedMutation<Args extends DefaultFunctionArgs, Out>(
  definition: AuthenticatedMutationDefinition<Args, Out>,
) {
  return mutation({
    args: definition.args ?? {},
    handler: async (ctx, args) => {
      const userId = await getAuthUserId(ctx)
      if (userId === null) {
        throw new ConvexError({ code: 'UNAUTHENTICATED', message: 'Sign-in required.' })
      }
      return definition.handler(Object.assign(ctx, { userId }), args as Args)
    },
  })
}
