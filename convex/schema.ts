/**
 * Convex schema for the cccollab backend.
 *
 * This composes the Convex Auth tables with cccollab's own domain tables.
 * Phase 2 scaffolds the auth/users layer only - the cccollab broker tables
 * (channels, sessions, topics, messages, ...) arrive in Phase 3.
 *
 * See `docs/architecture/mcp-servers.md` for the additive-only backend
 * discipline that governs any future changes to this schema.
 */
import { authTables } from '@convex-dev/auth/server'
import { defineSchema } from 'convex/server'

import { usersTable } from './users/schema'

export default defineSchema({
  ...authTables,
  users: usersTable,
})
