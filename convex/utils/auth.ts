import { getAuthUserId } from '@convex-dev/auth/server'
import { customCtx, customMutation, customQuery } from 'convex-helpers/server/customFunctions'
import { ConvexError } from 'convex/values'

import type { Id } from '../_generated/dataModel'
import { type MutationCtx, type QueryCtx, mutation, query } from '../_generated/server'

/**
 * `authenticatedQuery` and `authenticatedMutation` wrap Convex's `query`
 * and `mutation` factories with a single precondition: the caller must be
 * signed in via Convex Auth. Handlers receive `ctx.userId: Id<'users'>`.
 *
 * Callers that need the full user document call `ctx.db.get(ctx.userId)`
 * themselves - the helper deliberately skips that read because most
 * mutations only use the userId as a foreign key and don't care about the
 * profile.
 *
 * Unauthenticated callers get an `UNAUTHENTICATED` `ConvexError` at the
 * handler boundary, which Convex serialises to the client as a structured
 * error.
 *
 * Implementation note: using `customQuery` / `customMutation` from
 * `convex-helpers/server/customFunctions` preserves the full Convex type
 * inference chain - args validator shapes flow through to handler
 * parameters exactly as they do with the stock `query` / `mutation`
 * factories.
 */
export const authenticatedQuery = customQuery(
  query,
  customCtx(async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (userId === null) {
      throw new ConvexError({ code: 'UNAUTHENTICATED', message: 'Sign-in required.' })
    }
    return { userId }
  }),
)

export const authenticatedMutation = customMutation(
  mutation,
  customCtx(async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (userId === null) {
      throw new ConvexError({ code: 'UNAUTHENTICATED', message: 'Sign-in required.' })
    }
    return { userId }
  }),
)

/**
 * Exported context types for helpers (functions called from inside a
 * handler that need to know they're operating under an authenticated ctx).
 */
export type AuthenticatedQueryCtx = QueryCtx & { userId: Id<'users'> }
export type AuthenticatedMutationCtx = MutationCtx & { userId: Id<'users'> }
