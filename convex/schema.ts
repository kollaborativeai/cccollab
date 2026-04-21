import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.optional(v.string()),
    displayName: v.string(),
  }).index('by_clerkId', ['clerkId']),

  channels: defineTable({
    name: v.string(),
    createdBy: v.id('users'),
  }).index('by_name', ['name']),

  topics: defineTable({
    name: v.string(),
    channelId: v.id('channels'),
    state: v.union(v.literal('active'), v.literal('archived')),
    createdBy: v.id('users'),
  })
    .index('by_channel', ['channelId'])
    .index('by_name_channel', ['name', 'channelId']),

  messages: defineTable({
    topicId: v.id('topics'),
    authorType: v.union(v.literal('session'), v.literal('external')),
    authorKey: v.string(),
    authorName: v.string(),
    text: v.string(),
  }).index('by_topic', ['topicId']),

  channelMemberships: defineTable({
    channelId: v.id('channels'),
    userId: v.id('users'),
  })
    .index('by_channel', ['channelId'])
    .index('by_user_channel', ['userId', 'channelId']),

  topicMemberships: defineTable({
    topicId: v.id('topics'),
    userId: v.id('users'),
  })
    .index('by_topic', ['topicId'])
    .index('by_user_topic', ['userId', 'topicId']),

  oauthClients: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod: v.union(v.literal('none'), v.literal('client_secret_post')),
    clientSecretHash: v.optional(v.string()),
  }).index('by_clientId', ['clientId']),

  oauthAuthCodes: defineTable({
    code: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.literal('S256'),
    scope: v.string(),
    expiresAt: v.number(),
    used: v.boolean(),
  }).index('by_code', ['code']),

  oauthAccessTokens: defineTable({
    token: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    scope: v.string(),
    expiresAt: v.number(),
    revoked: v.boolean(),
  }).index('by_token', ['token']),

  oauthRefreshTokens: defineTable({
    token: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    scope: v.string(),
    expiresAt: v.number(),
    revoked: v.boolean(),
  }).index('by_token', ['token']),
})
