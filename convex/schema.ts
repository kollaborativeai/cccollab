/**
 * Convex schema for the cccollab backend.
 *
 * Composes Convex Auth's managed tables (users, auth accounts, sessions,
 * verification codes) with cccollab's domain tables. The domain tables
 * mirror the local broker's in-memory model
 * (`mcp_server/src/broker.ts`) but are a superset of it:
 *
 * - The broker has only "sessions"; Convex separates user-level standing
 *   subscriptions (`channelMembers`) from session-level presence
 *   (`sessionChannels`), so a subscription survives MCP server restarts
 *   across machines.
 * - The broker's "sessionName" is a globally unique string; Convex scopes
 *   uniqueness to the user (two people can both call a session
 *   "architect") and keys all foreign references by `Id<'sessions'>`.
 *
 * See `docs/architecture/mcp-servers.md` for the additive-only backend
 * discipline that governs any future changes to this schema.
 */
import { authTables } from '@convex-dev/auth/server'
import { defineSchema } from 'convex/server'

import { channelMembersTable } from './channelMembers/schema'
import { channelsTable } from './channels/schema'
import { messagesTable } from './messages/schema'
import { oauthAccessTokensTable } from './oauthAccessTokens/schema'
import { oauthAuthCodesTable } from './oauthAuthCodes/schema'
import { oauthClientsTable } from './oauthClients/schema'
import { oauthRefreshTokensTable } from './oauthRefreshTokens/schema'
import { sessionChannelsTable } from './sessionChannels/schema'
import { sessionsTable } from './sessions/schema'
import { topicMembersTable } from './topicMembers/schema'
import { topicsTable } from './topics/schema'
import { usersTable } from './users/schema'

export default defineSchema({
  ...authTables,
  users: usersTable,

  // cccollab domain tables
  channels: channelsTable,
  channelMembers: channelMembersTable,
  sessions: sessionsTable,
  sessionChannels: sessionChannelsTable,
  topics: topicsTable,
  topicMembers: topicMembersTable,
  messages: messagesTable,

  // CCC-22 OAuth 2.1 authorization-server tables (external AI clients).
  oauthClients: oauthClientsTable,
  oauthAuthCodes: oauthAuthCodesTable,
  oauthAccessTokens: oauthAccessTokensTable,
  oauthRefreshTokens: oauthRefreshTokensTable,
})
