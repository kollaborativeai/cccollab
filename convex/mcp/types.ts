import type { GenericActionCtx } from 'convex/server'
import type { DataModel } from '../_generated/dataModel.js'

/**
 * The subset of a Convex context needed to dispatch MCP tools. Narrowing it
 * here means the dispatcher works for both `GenericActionCtx` (HTTP actions
 * in production) and `GenericMutationCtx` (what `convex-test`'s `t.run`
 * hands us in tests) — they both expose `runQuery` / `runMutation` with
 * identical signatures.
 */
export type McpCtx = {
  runQuery: GenericActionCtx<DataModel>['runQuery']
  runMutation: GenericActionCtx<DataModel>['runMutation']
}
