# CCC-22 HTTP MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hosted HTTP MCP server (Convex HTTP action) that lets external AI clients (Claude.ai, ChatGPT, Cursor, Gemini) connect to cccollab topics via OAuth 2.1, list/read topics, and post messages attributed to the external user.

**Architecture:** New `convex/` directory with schema, OAuth 2.1 authorization server, and MCP streamable HTTP transport all implemented as Convex HTTP actions. A thin optional bridge (`src/bridge/convex-bridge.ts`) forwards messages from Convex to the existing local broker so Claude Code sessions see external messages in real time.

**Tech Stack:** Convex, TypeScript, Clerk (for user identity), Vitest, `convex-test` (for Convex unit tests), `@modelcontextprotocol/sdk`.

---

## File Structure

```
convex/
├── schema.ts                 # DB schema (users, topics, messages, memberships, oauth state)
├── auth.config.ts            # Clerk JWT issuer config
├── http.ts                   # HTTP router mounting all endpoints
├── lib/
│   ├── auth.ts               # Auth helpers (resolveUserFromClerk, resolveUserFromBearer)
│   ├── crypto.ts             # Crypto helpers (random token, SHA-256, PKCE verify)
│   ├── http.ts               # HTTP helpers (jsonResponse, readBody)
│   └── time.ts               # Time helpers (nowMs, expiresAt)
├── users.ts                  # User functions (getOrCreate, getByClerkId)
├── channels.ts               # Channel functions (list, create, join, leave)
├── topics.ts                 # Topic functions (list, read, create, join)
├── messages.ts               # Message functions (list, create)
├── memberships.ts            # Membership functions (list, check)
├── oauth/
│   ├── metadata.ts           # Authorization Server + Protected Resource metadata
│   ├── register.ts           # Dynamic Client Registration
│   ├── authorize.ts          # Authorization endpoint
│   ├── token.ts              # Token endpoint (exchange + refresh)
│   └── tokens.ts             # Token store queries/mutations
├── mcp/
│   ├── server.ts             # MCP JSON-RPC dispatcher
│   └── tools/
│       ├── listTopics.ts
│       ├── readTopic.ts
│       └── sendMessageToTopic.ts
├── tests/                    # convex-test based tests
│   ├── users.test.ts
│   ├── topics.test.ts
│   ├── messages.test.ts
│   ├── oauth.test.ts
│   └── mcp.test.ts
└── _generated/               # Auto-generated, gitignored

src/
└── bridge/
    ├── convex-bridge.ts      # Optional Convex->broker bridge (new)
    └── convex-bridge.bin.ts  # CLI entry for bridge

tests/
└── scenarios/                # End-to-end scenario tests (new)
    ├── README.md
    ├── harness.ts            # Test harness: Convex test runtime + fake Clerk
    ├── oauth-flow.scenario.test.ts
    ├── mcp-tools.scenario.test.ts
    ├── attribution.scenario.test.ts
    ├── cross-visibility.scenario.test.ts
    └── scoping.scenario.test.ts

docs/
└── CCC-22-http-mcp.md        # Deployment + setup docs
```

---

## Phase 1: Scaffolding

### Task 1: Add Convex dev dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add Convex + testing deps**

Update `package.json` dependencies and devDependencies:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "convex": "^1.28.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@clerk/backend": "^2.0.0",
    "@edge-runtime/vm": "^5.0.0",
    "convex-test": "^0.0.38",
    ...existing
  }
}
```

- [ ] **Step 2: Install**

Run: `yarn install`
Expected: succeeds, lockfile updated.

- [ ] **Step 3: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore(ccc-22): add Convex, clerk backend, and convex-test dev deps"
```

### Task 2: Scaffold `convex/` directory

**Files:**

- Create: `convex/_disabled.ts` (placeholder, will be replaced)
- Create: `convex/README.md`
- Create: `convex/.gitignore`
- Modify: `.gitignore`

- [ ] **Step 1: Create `convex/README.md`**

````markdown
# cccollab Convex Backend

Hosts the HTTP MCP server for CCC-22 (external LLM participants in topics).

## Development

```bash
npx convex dev
```
````

This starts a local Convex dev server and pushes any code changes in `convex/`. URLs are printed on startup.

## Environment

See `.env.example` at repo root.

```

- [ ] **Step 2: Create `convex/.gitignore`**

```

\_generated/

```

- [ ] **Step 3: Append to root `.gitignore`**

```

# Convex

convex/\_generated/
.env.local

````

- [ ] **Step 4: Commit**

```bash
git add convex/ .gitignore
git commit -m "chore(ccc-22): scaffold convex/ directory"
````

### Task 3: Schema definition

**Files:**

- Create: `convex/schema.ts`

- [ ] **Step 1: Write `convex/schema.ts`**

```typescript
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
    authorKey: v.string(), // Clerk userId for external, session name for session
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
```

- [ ] **Step 2: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(ccc-22): add Convex schema for topics, messages, memberships, OAuth state"
```

### Task 4: Auth config + env example

**Files:**

- Create: `convex/auth.config.ts`
- Create: `.env.example`

- [ ] **Step 1: Write `convex/auth.config.ts`**

```typescript
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN ?? 'https://example.clerk.accounts.dev',
      applicationID: 'convex',
    },
  ],
}
```

- [ ] **Step 2: Create `.env.example`**

```bash
# Clerk
CLERK_JWT_ISSUER_DOMAIN=https://your-instance.clerk.accounts.dev
CLERK_SECRET_KEY=sk_test_...

# Convex deployment URL (for the plugin bridge)
CCCOLLAB_CONVEX_URL=https://your-deployment.convex.cloud
```

- [ ] **Step 3: Commit**

```bash
git add convex/auth.config.ts .env.example
git commit -m "chore(ccc-22): add Clerk auth.config and .env.example"
```

---

## Phase 2: Convex library helpers

### Task 5: Crypto helpers

**Files:**

- Create: `convex/lib/crypto.ts`
- Create: `convex/tests/crypto.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// convex/tests/crypto.test.ts
import { describe, it, expect } from 'vitest'
import { randomToken, sha256Base64Url, verifyPkceS256 } from '../lib/crypto'

describe('crypto helpers', () => {
  it('randomToken returns url-safe string of expected length', () => {
    const t = randomToken(32)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(t.length).toBeGreaterThanOrEqual(43) // 32 bytes -> 43 base64url chars
  })

  it('sha256Base64Url returns url-safe base64 of sha256', async () => {
    const h = await sha256Base64Url('hello')
    expect(h).toBe('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')
  })

  it('verifyPkceS256 validates a known challenge/verifier', async () => {
    // verifier 'abc123', challenge = base64url(sha256('abc123'))
    const ok = await verifyPkceS256({
      verifier: 'abc123',
      challenge: await sha256Base64Url('abc123'),
    })
    expect(ok).toBe(true)
    const bad = await verifyPkceS256({
      verifier: 'abc123',
      challenge: 'wrong',
    })
    expect(bad).toBe(false)
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `yarn vitest run convex/tests/crypto.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `convex/lib/crypto.ts`**

```typescript
// Uses Web Crypto API (available in Convex runtime and Node >= 20).
function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  // btoa isn't in Convex runtime reliably; fall back to manual encoding:
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  const b64 = typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return toBase64Url(digest)
}

export async function verifyPkceS256(args: { verifier: string; challenge: string }): Promise<boolean> {
  const expected = await sha256Base64Url(args.verifier)
  return expected === args.challenge
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `yarn vitest run convex/tests/crypto.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/crypto.ts convex/tests/crypto.test.ts
git commit -m "feat(ccc-22): crypto helpers for PKCE and random tokens"
```

### Task 6: HTTP + time helpers

**Files:**

- Create: `convex/lib/http.ts`
- Create: `convex/lib/time.ts`

- [ ] **Step 1: Write `convex/lib/time.ts`**

```typescript
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000 // 1h
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30d
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000 // 10m

export function nowMs(): number {
  return Date.now()
}

export function isExpired(expiresAt: number): boolean {
  return nowMs() >= expiresAt
}
```

- [ ] **Step 2: Write `convex/lib/http.ts`**

```typescript
export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'Content-Type': 'application/json',
    },
  })
}

export function errorResponse(status: number, error: string, description?: string): Response {
  return jsonResponse({ error, error_description: description }, { status })
}

export async function readJsonBody<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new Error('Invalid JSON body')
  }
}

export async function readFormBody(req: Request): Promise<URLSearchParams> {
  const text = await req.text()
  return new URLSearchParams(text)
}
```

- [ ] **Step 3: Commit**

```bash
git add convex/lib/http.ts convex/lib/time.ts
git commit -m "feat(ccc-22): convex http/time helpers"
```

---

## Phase 3: Core data operations

### Task 7: Users — JIT creation from Clerk identity

**Files:**

- Create: `convex/users.ts`
- Create: `convex/tests/users.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// convex/tests/users.test.ts
import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema'
import { api } from '../_generated/api'

describe('users', () => {
  it('getOrCreate by clerkId inserts once, returns same id on second call', async () => {
    const t = convexTest(schema)
    const u1 = await t.mutation(api.users.getOrCreateByClerk, {
      clerkId: 'u_1',
      email: 'alice@example.com',
      displayName: 'Alice',
    })
    const u2 = await t.mutation(api.users.getOrCreateByClerk, {
      clerkId: 'u_1',
      email: 'alice@example.com',
      displayName: 'Alice Renamed',
    })
    expect(u1).toEqual(u2)
    const row = await t.query(api.users.getById, { userId: u1 })
    expect(row?.displayName).toBe('Alice Renamed') // updates on second call
  })

  it('getByClerkId returns null if not found', async () => {
    const t = convexTest(schema)
    const row = await t.query(api.users.getByClerkId, { clerkId: 'nope' })
    expect(row).toBeNull()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `yarn vitest run convex/tests/users.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `convex/users.ts`**

```typescript
import { query, mutation } from './_generated/server'
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'

export const getByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }): Promise<Doc<'users'> | null> => {
    return await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique()
  },
})

export const getById = query({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }): Promise<Doc<'users'> | null> => {
    return await ctx.db.get(userId)
  },
})

export const getOrCreateByClerk = mutation({
  args: {
    clerkId: v.string(),
    email: v.optional(v.string()),
    displayName: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'users'>> => {
    const existing = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', args.clerkId))
      .unique()
    if (existing) {
      // keep displayName/email in sync
      if (existing.displayName !== args.displayName || existing.email !== args.email) {
        await ctx.db.patch(existing._id, { displayName: args.displayName, email: args.email })
      }
      return existing._id
    }
    return await ctx.db.insert('users', {
      clerkId: args.clerkId,
      email: args.email,
      displayName: args.displayName,
    })
  },
})
```

- [ ] **Step 4: Tests pass**

Run: `yarn vitest run convex/tests/users.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/users.ts convex/tests/users.test.ts
git commit -m "feat(ccc-22): users table with just-in-time Clerk sync"
```

### Task 8: Channels — create + membership

**Files:**

- Create: `convex/channels.ts`
- Create: `convex/tests/channels.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// convex/tests/channels.test.ts
import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema'
import { api } from '../_generated/api'

describe('channels', () => {
  it('getOrCreate is idempotent by name', async () => {
    const t = convexTest(schema)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const c1 = await t.mutation(api.channels.getOrCreate, { name: 'general', creatorUserId: userId })
    const c2 = await t.mutation(api.channels.getOrCreate, { name: 'general', creatorUserId: userId })
    expect(c1).toEqual(c2)
  })

  it('join + list returns the channel', async () => {
    const t = convexTest(schema)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: userId })
    await t.mutation(api.channels.join, { channelId, userId })
    const channels = await t.query(api.channels.listForUser, { userId })
    expect(channels.map((c) => c.name)).toEqual(['eng'])
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `yarn vitest run convex/tests/channels.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `convex/channels.ts`**

```typescript
import { query, mutation } from './_generated/server'
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'

export const getOrCreate = mutation({
  args: { name: v.string(), creatorUserId: v.id('users') },
  handler: async (ctx, { name, creatorUserId }): Promise<Id<'channels'>> => {
    const existing = await ctx.db
      .query('channels')
      .withIndex('by_name', (q) => q.eq('name', name))
      .unique()
    if (existing) return existing._id
    return await ctx.db.insert('channels', { name, createdBy: creatorUserId })
  },
})

export const join = mutation({
  args: { channelId: v.id('channels'), userId: v.id('users') },
  handler: async (ctx, { channelId, userId }) => {
    const existing = await ctx.db
      .query('channelMemberships')
      .withIndex('by_user_channel', (q) => q.eq('userId', userId).eq('channelId', channelId))
      .unique()
    if (existing) return existing._id
    return await ctx.db.insert('channelMemberships', { channelId, userId })
  },
})

export const listForUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }): Promise<Doc<'channels'>[]> => {
    const memberships = await ctx.db
      .query('channelMemberships')
      .withIndex('by_user_channel', (q) => q.eq('userId', userId))
      .collect()
    const results: Doc<'channels'>[] = []
    for (const m of memberships) {
      const c = await ctx.db.get(m.channelId)
      if (c) results.push(c)
    }
    return results
  },
})
```

- [ ] **Step 4: Pass tests**

Run: `yarn vitest run convex/tests/channels.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/channels.ts convex/tests/channels.test.ts
git commit -m "feat(ccc-22): channels with idempotent create and per-user membership"
```

### Task 9: Topics — create, list (by user membership), read

**Files:**

- Create: `convex/topics.ts`
- Create: `convex/tests/topics.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// convex/tests/topics.test.ts
import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema'
import { api } from '../_generated/api'

describe('topics', () => {
  it('listForUser returns only topics where user is a member', async () => {
    const t = convexTest(schema)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'Bob' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    await t.mutation(api.channels.join, { channelId, userId: alice })
    await t.mutation(api.channels.join, { channelId, userId: bob })

    const topicId = await t.mutation(api.topics.create, {
      name: 'design-review',
      channelId,
      creatorUserId: alice,
    })

    // Only Alice is a member
    const aliceTopics = await t.query(api.topics.listForUser, { userId: alice })
    const bobTopics = await t.query(api.topics.listForUser, { userId: bob })

    expect(aliceTopics.map((t) => t._id)).toEqual([topicId])
    expect(bobTopics).toEqual([])
  })

  it('readForUser returns topic + messages when user is member; null otherwise', async () => {
    const t = convexTest(schema)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'Bob' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'dr', channelId, creatorUserId: alice })
    await t.mutation(api.messages.send, {
      topicId,
      authorType: 'external',
      authorKey: 'a',
      authorName: 'Alice',
      text: 'hi',
    })

    const aliceView = await t.query(api.topics.readForUser, { topicId, userId: alice })
    expect(aliceView?.messages.length).toBe(1)

    const bobView = await t.query(api.topics.readForUser, { topicId, userId: bob })
    expect(bobView).toBeNull()
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `yarn vitest run convex/tests/topics.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `convex/topics.ts`**

```typescript
import { query, mutation } from './_generated/server'
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'

export const create = mutation({
  args: { name: v.string(), channelId: v.id('channels'), creatorUserId: v.id('users') },
  handler: async (ctx, { name, channelId, creatorUserId }): Promise<Id<'topics'>> => {
    const existing = await ctx.db
      .query('topics')
      .withIndex('by_name_channel', (q) => q.eq('name', name).eq('channelId', channelId))
      .unique()
    if (existing && existing.state === 'active') return existing._id
    const topicId = await ctx.db.insert('topics', { name, channelId, state: 'active', createdBy: creatorUserId })
    await ctx.db.insert('topicMemberships', { topicId, userId: creatorUserId })
    return topicId
  },
})

export const join = mutation({
  args: { topicId: v.id('topics'), userId: v.id('users') },
  handler: async (ctx, { topicId, userId }) => {
    const existing = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', userId).eq('topicId', topicId))
      .unique()
    if (existing) return existing._id
    return await ctx.db.insert('topicMemberships', { topicId, userId })
  },
})

export const listForUser = query({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }): Promise<Doc<'topics'>[]> => {
    const memberships = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', userId))
      .collect()
    const out: Doc<'topics'>[] = []
    for (const m of memberships) {
      const topic = await ctx.db.get(m.topicId)
      if (topic && topic.state === 'active') out.push(topic)
    }
    return out
  },
})

export const readForUser = query({
  args: { topicId: v.id('topics'), userId: v.id('users') },
  handler: async (ctx, { topicId, userId }) => {
    const membership = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', userId).eq('topicId', topicId))
      .unique()
    if (!membership) return null
    const topic = await ctx.db.get(topicId)
    if (!topic) return null
    const messages = await ctx.db
      .query('messages')
      .withIndex('by_topic', (q) => q.eq('topicId', topicId))
      .collect()
    return { topic, messages }
  },
})
```

- [ ] **Step 4: Pass tests**

Run: `yarn vitest run convex/tests/topics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/topics.ts convex/tests/topics.test.ts
git commit -m "feat(ccc-22): topics create/join/list/read scoped by user membership"
```

### Task 10: Messages — send + list

**Files:**

- Create: `convex/messages.ts`
- Create: `convex/tests/messages.test.ts`

- [ ] **Step 1: Failing test**

```typescript
// convex/tests/messages.test.ts
import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema'
import { api } from '../_generated/api'

describe('messages', () => {
  it('send stores message with attribution fields', async () => {
    const t = convexTest(schema)
    const u = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'User' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: u })
    const topicId = await t.mutation(api.topics.create, { name: 't', channelId, creatorUserId: u })
    const messageId = await t.mutation(api.messages.send, {
      topicId,
      authorType: 'external',
      authorKey: 'u',
      authorName: 'User',
      text: 'hello',
    })
    const list = await t.query(api.messages.listForTopic, { topicId })
    expect(list).toMatchObject([{ _id: messageId, authorType: 'external', authorName: 'User', text: 'hello' }])
  })

  it('rejects send from non-member external user', async () => {
    const t = convexTest(schema)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'A' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'B' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 't', channelId, creatorUserId: alice })
    await expect(
      t.mutation(api.messages.sendAsUser, {
        topicId,
        userId: bob,
        text: 'intruder',
      }),
    ).rejects.toThrow(/not a member/i)
  })
})
```

- [ ] **Step 2: Run failing test**

Run: `yarn vitest run convex/tests/messages.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `convex/messages.ts`**

```typescript
import { query, mutation } from './_generated/server'
import { v } from 'convex/values'
import type { Doc, Id } from './_generated/dataModel'

export const send = mutation({
  args: {
    topicId: v.id('topics'),
    authorType: v.union(v.literal('session'), v.literal('external')),
    authorKey: v.string(),
    authorName: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'messages'>> => {
    return await ctx.db.insert('messages', args)
  },
})

/**
 * Membership-enforced message send for an authenticated user (external client).
 * Throws if the user is not a member of the topic.
 */
export const sendAsUser = mutation({
  args: {
    topicId: v.id('topics'),
    userId: v.id('users'),
    text: v.string(),
  },
  handler: async (ctx, { topicId, userId, text }): Promise<Id<'messages'>> => {
    const membership = await ctx.db
      .query('topicMemberships')
      .withIndex('by_user_topic', (q) => q.eq('userId', userId).eq('topicId', topicId))
      .unique()
    if (!membership) {
      throw new Error(`User is not a member of this topic`)
    }
    const user = await ctx.db.get(userId)
    if (!user) throw new Error('User not found')
    return await ctx.db.insert('messages', {
      topicId,
      authorType: 'external',
      authorKey: user.clerkId,
      authorName: user.displayName,
      text,
    })
  },
})

export const listForTopic = query({
  args: { topicId: v.id('topics') },
  handler: async (ctx, { topicId }): Promise<Doc<'messages'>[]> => {
    return await ctx.db
      .query('messages')
      .withIndex('by_topic', (q) => q.eq('topicId', topicId))
      .collect()
  },
})
```

- [ ] **Step 4: Tests pass**

Run: `yarn vitest run convex/tests/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/messages.ts convex/tests/messages.test.ts
git commit -m "feat(ccc-22): messages send + list with per-topic membership enforcement"
```

---

## Phase 4: OAuth 2.1 Authorization Server

### Task 11: OAuth token store

**Files:**

- Create: `convex/oauth/tokens.ts`

- [ ] **Step 1: Implement `convex/oauth/tokens.ts`**

```typescript
import { internalMutation, internalQuery } from '../_generated/server'
import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, AUTH_CODE_TTL_MS, nowMs } from '../lib/time'

export const storeAuthCode = internalMutation({
  args: {
    code: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.literal('S256'),
    scope: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'oauthAuthCodes'>> => {
    return await ctx.db.insert('oauthAuthCodes', {
      ...args,
      expiresAt: nowMs() + AUTH_CODE_TTL_MS,
      used: false,
    })
  },
})

export const consumeAuthCode = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<Doc<'oauthAuthCodes'> | null> => {
    const row = await ctx.db
      .query('oauthAuthCodes')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!row) return null
    if (row.used || row.expiresAt < nowMs()) return null
    await ctx.db.patch(row._id, { used: true })
    return row
  },
})

export const issueAccessToken = internalMutation({
  args: {
    token: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    scope: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'oauthAccessTokens'>> => {
    return await ctx.db.insert('oauthAccessTokens', {
      ...args,
      expiresAt: nowMs() + ACCESS_TOKEN_TTL_MS,
      revoked: false,
    })
  },
})

export const issueRefreshToken = internalMutation({
  args: {
    token: v.string(),
    clientId: v.string(),
    userId: v.id('users'),
    scope: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'oauthRefreshTokens'>> => {
    return await ctx.db.insert('oauthRefreshTokens', {
      ...args,
      expiresAt: nowMs() + REFRESH_TOKEN_TTL_MS,
      revoked: false,
    })
  },
})

export const resolveAccessToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<Doc<'oauthAccessTokens'> | null> => {
    const row = await ctx.db
      .query('oauthAccessTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique()
    if (!row) return null
    if (row.revoked || row.expiresAt < nowMs()) return null
    return row
  },
})

export const consumeRefreshToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<Doc<'oauthRefreshTokens'> | null> => {
    const row = await ctx.db
      .query('oauthRefreshTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique()
    if (!row) return null
    if (row.revoked || row.expiresAt < nowMs()) return null
    await ctx.db.patch(row._id, { revoked: true })
    return row
  },
})
```

- [ ] **Step 2: Commit**

```bash
git add convex/oauth/tokens.ts
git commit -m "feat(ccc-22): oauth token store (auth codes, access + refresh tokens)"
```

### Task 12: OAuth Dynamic Client Registration

**Files:**

- Create: `convex/oauth/register.ts`
- Create: `convex/tests/oauth.test.ts` (will grow through OAuth tasks)

- [ ] **Step 1: Failing test (first of OAuth tests)**

```typescript
// convex/tests/oauth.test.ts (initial)
import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema'
import { api } from '../_generated/api'

describe('OAuth dynamic client registration', () => {
  it('registers a client and returns client_id', async () => {
    const t = convexTest(schema)
    const result = await t.mutation(api.oauth.register.register, {
      clientName: 'Test AI Client',
      redirectUris: ['http://localhost:8765/callback'],
      tokenEndpointAuthMethod: 'none',
    })
    expect(result.client_id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(result.client_name).toBe('Test AI Client')
    expect(result.redirect_uris).toEqual(['http://localhost:8765/callback'])
    expect(result.token_endpoint_auth_method).toBe('none')
    expect(result.client_secret).toBeUndefined()
  })

  it('registers a confidential client with a client_secret', async () => {
    const t = convexTest(schema)
    const result = await t.mutation(api.oauth.register.register, {
      clientName: 'Confidential AI',
      redirectUris: ['https://example.com/cb'],
      tokenEndpointAuthMethod: 'client_secret_post',
    })
    expect(result.client_secret).toBeDefined()
    expect(result.client_secret!.length).toBeGreaterThan(20)
  })
})
```

- [ ] **Step 2: Implement `convex/oauth/register.ts`**

```typescript
import { mutation } from '../_generated/server'
import { v } from 'convex/values'
import { randomToken, sha256Base64Url } from '../lib/crypto'

export const register = mutation({
  args: {
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    tokenEndpointAuthMethod: v.union(v.literal('none'), v.literal('client_secret_post')),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    client_id: string
    client_secret?: string
    client_name: string
    redirect_uris: string[]
    token_endpoint_auth_method: 'none' | 'client_secret_post'
  }> => {
    if (args.redirectUris.length === 0) {
      throw new Error('redirect_uris must not be empty')
    }
    for (const uri of args.redirectUris) {
      try {
        const u = new URL(uri)
        if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
          throw new Error(`redirect_uri must be https or localhost: ${uri}`)
        }
      } catch {
        throw new Error(`invalid redirect_uri: ${uri}`)
      }
    }
    const clientId = randomToken(16)
    let clientSecret: string | undefined
    let clientSecretHash: string | undefined
    if (args.tokenEndpointAuthMethod === 'client_secret_post') {
      clientSecret = randomToken(32)
      clientSecretHash = await sha256Base64Url(clientSecret)
    }
    await ctx.db.insert('oauthClients', {
      clientId,
      clientName: args.clientName,
      redirectUris: args.redirectUris,
      tokenEndpointAuthMethod: args.tokenEndpointAuthMethod,
      clientSecretHash,
    })
    return {
      client_id: clientId,
      client_secret: clientSecret,
      client_name: args.clientName,
      redirect_uris: args.redirectUris,
      token_endpoint_auth_method: args.tokenEndpointAuthMethod,
    }
  },
})
```

- [ ] **Step 3: Tests pass**

Run: `yarn vitest run convex/tests/oauth.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/oauth/register.ts convex/tests/oauth.test.ts
git commit -m "feat(ccc-22): oauth dynamic client registration (RFC 7591)"
```

### Task 13: OAuth Authorization endpoint (code issuance)

**Files:**

- Create: `convex/oauth/authorize.ts`
- Modify: `convex/tests/oauth.test.ts`

- [ ] **Step 1: Extend OAuth tests with authorize flow**

Append to `convex/tests/oauth.test.ts`:

```typescript
describe('OAuth authorize', () => {
  it('issues an auth code for authenticated user + valid client/params', async () => {
    const t = convexTest(schema)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })

    const result = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:1/cb',
      codeChallenge: 'fake-challenge',
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })

    expect(result.code).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('rejects unknown clientId', async () => {
    const t = convexTest(schema)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    await expect(
      t.mutation(api.oauth.authorize.issueAuthCode, {
        clientId: 'nonexistent',
        redirectUri: 'http://localhost:1/cb',
        codeChallenge: 'x',
        codeChallengeMethod: 'S256',
        scope: 'cccollab:topics.rw',
        userId,
      }),
    ).rejects.toThrow(/unknown client/i)
  })

  it('rejects mismatched redirectUri', async () => {
    const t = convexTest(schema)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    await expect(
      t.mutation(api.oauth.authorize.issueAuthCode, {
        clientId: client.client_id,
        redirectUri: 'http://evil.example/cb',
        codeChallenge: 'x',
        codeChallengeMethod: 'S256',
        scope: 'cccollab:topics.rw',
        userId,
      }),
    ).rejects.toThrow(/redirect/i)
  })
})
```

- [ ] **Step 2: Implement `convex/oauth/authorize.ts`**

```typescript
import { mutation } from '../_generated/server'
import { internal } from '../_generated/api'
import { v } from 'convex/values'
import { randomToken } from '../lib/crypto'

export const issueAuthCode = mutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.literal('S256'),
    scope: v.string(),
    userId: v.id('users'),
  },
  handler: async (ctx, args): Promise<{ code: string }> => {
    const client = await ctx.db
      .query('oauthClients')
      .withIndex('by_clientId', (q) => q.eq('clientId', args.clientId))
      .unique()
    if (!client) throw new Error('unknown client')
    if (!client.redirectUris.includes(args.redirectUri)) throw new Error('redirect_uri not registered for client')
    const code = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.storeAuthCode, {
      code,
      clientId: args.clientId,
      userId: args.userId,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      codeChallengeMethod: 'S256',
      scope: args.scope,
    })
    return { code }
  },
})
```

- [ ] **Step 3: Pass tests**

Run: `yarn vitest run convex/tests/oauth.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/oauth/authorize.ts convex/tests/oauth.test.ts
git commit -m "feat(ccc-22): oauth authorize (issues PKCE-bound auth codes)"
```

### Task 14: OAuth Token endpoint (exchange + refresh)

**Files:**

- Create: `convex/oauth/token.ts`
- Modify: `convex/tests/oauth.test.ts`

- [ ] **Step 1: Tests for token exchange**

Append to `convex/tests/oauth.test.ts`:

```typescript
describe('OAuth token exchange', () => {
  it('exchanges code + verifier for access_token + refresh_token', async () => {
    const t = convexTest(schema)
    const { sha256Base64Url } = await import('../lib/crypto')
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const verifier = 'abcdef1234567890'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:1/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })

    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:1/cb',
    })
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.access_token.length).toBeGreaterThan(20)
    expect(tokens.refresh_token.length).toBeGreaterThan(20)
    expect(tokens.expires_in).toBeGreaterThan(0)
  })

  it('rejects exchange with invalid PKCE verifier', async () => {
    const t = convexTest(schema)
    const { sha256Base64Url } = await import('../lib/crypto')
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:1/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const verifier = 'legit-verifier'
    const challenge = await sha256Base64Url(verifier)
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:1/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })

    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: 'wrong-verifier',
        redirectUri: 'http://localhost:1/cb',
      }),
    ).rejects.toThrow(/pkce|verifier/i)
  })
})
```

- [ ] **Step 2: Implement `convex/oauth/token.ts`**

```typescript
import { action } from '../_generated/server'
import { internal } from '../_generated/api'
import { v } from 'convex/values'
import { randomToken, verifyPkceS256 } from '../lib/crypto'
import { ACCESS_TOKEN_TTL_MS } from '../lib/time'

export const exchangeAuthCode = action({
  args: {
    clientId: v.string(),
    code: v.string(),
    codeVerifier: v.string(),
    redirectUri: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    scope: string
  }> => {
    const codeRow = await ctx.runMutation(internal.oauth.tokens.consumeAuthCode, { code: args.code })
    if (!codeRow) throw new Error('invalid or expired code')
    if (codeRow.clientId !== args.clientId) throw new Error('client_id mismatch')
    if (codeRow.redirectUri !== args.redirectUri) throw new Error('redirect_uri mismatch')
    const ok = await verifyPkceS256({ verifier: args.codeVerifier, challenge: codeRow.codeChallenge })
    if (!ok) throw new Error('pkce verifier mismatch')
    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.issueAccessToken, {
      token: accessToken,
      clientId: codeRow.clientId,
      userId: codeRow.userId,
      scope: codeRow.scope,
    })
    await ctx.runMutation(internal.oauth.tokens.issueRefreshToken, {
      token: refreshToken,
      clientId: codeRow.clientId,
      userId: codeRow.userId,
      scope: codeRow.scope,
    })
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: codeRow.scope,
    }
  },
})

export const refreshAccessToken = action({
  args: { clientId: v.string(), refreshToken: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    access_token: string
    refresh_token: string
    token_type: 'Bearer'
    expires_in: number
    scope: string
  }> => {
    const row = await ctx.runMutation(internal.oauth.tokens.consumeRefreshToken, { token: args.refreshToken })
    if (!row) throw new Error('invalid or expired refresh_token')
    if (row.clientId !== args.clientId) throw new Error('client_id mismatch')
    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    await ctx.runMutation(internal.oauth.tokens.issueAccessToken, {
      token: accessToken,
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
    })
    await ctx.runMutation(internal.oauth.tokens.issueRefreshToken, {
      token: refreshToken,
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scope,
    })
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: row.scope,
    }
  },
})
```

- [ ] **Step 3: Tests pass**

Run: `yarn vitest run convex/tests/oauth.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add convex/oauth/token.ts convex/tests/oauth.test.ts
git commit -m "feat(ccc-22): oauth token endpoint (auth-code exchange + refresh, PKCE S256)"
```

### Task 15: OAuth metadata + HTTP wiring

**Files:**

- Create: `convex/oauth/metadata.ts`
- Create: `convex/http.ts`

- [ ] **Step 1: `convex/oauth/metadata.ts` (pure data)**

```typescript
export function authServerMetadata(baseUrl: string): unknown {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['cccollab:topics.rw'],
  }
}

export function protectedResourceMetadata(baseUrl: string): unknown {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: ['cccollab:topics.rw'],
    bearer_methods_supported: ['header'],
  }
}
```

- [ ] **Step 2: `convex/http.ts` — mount OAuth and MCP routes**

```typescript
import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { internal, api } from './_generated/api'
import { authServerMetadata, protectedResourceMetadata } from './oauth/metadata'
import { jsonResponse, errorResponse, readFormBody, readJsonBody } from './lib/http'

const http = httpRouter()

function baseUrl(req: Request): string {
  return new URL(req.url).origin
}

http.route({
  path: '/.well-known/oauth-authorization-server',
  method: 'GET',
  handler: httpAction(async (_ctx, req) => jsonResponse(authServerMetadata(baseUrl(req)))),
})

http.route({
  path: '/.well-known/oauth-protected-resource',
  method: 'GET',
  handler: httpAction(async (_ctx, req) => jsonResponse(protectedResourceMetadata(baseUrl(req)))),
})

http.route({
  path: '/register',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const body = await readJsonBody<{
      client_name?: string
      redirect_uris?: string[]
      token_endpoint_auth_method?: 'none' | 'client_secret_post'
    }>(req)
    if (!body.client_name || !Array.isArray(body.redirect_uris)) {
      return errorResponse(400, 'invalid_request', 'client_name and redirect_uris required')
    }
    try {
      const result = await ctx.runMutation(api.oauth.register.register, {
        clientName: body.client_name,
        redirectUris: body.redirect_uris,
        tokenEndpointAuthMethod: body.token_endpoint_auth_method ?? 'none',
      })
      return jsonResponse(result, { status: 201 })
    } catch (err) {
      return errorResponse(400, 'invalid_client_metadata', err instanceof Error ? err.message : 'error')
    }
  }),
})

// /authorize and /token wiring comes next; put placeholder routes here (fill in task 16).
export default http
```

- [ ] **Step 3: Commit**

```bash
git add convex/oauth/metadata.ts convex/http.ts
git commit -m "feat(ccc-22): oauth metadata endpoints + /register HTTP wiring"
```

### Task 16: OAuth /authorize and /token HTTP endpoints

**Files:**

- Modify: `convex/http.ts`

- [ ] **Step 1: Add /authorize and /token routes to `convex/http.ts`**

Insert before `export default http`:

```typescript
/**
 * /authorize — minimal consent HTML for MVP. Requires the user to be
 * authenticated via Clerk; we read Clerk identity from the request headers
 * (or a dev-mode mock header in testing).
 *
 * Query params (per RFC 6749 + PKCE):
 *   response_type=code
 *   client_id
 *   redirect_uri
 *   code_challenge
 *   code_challenge_method=S256
 *   scope
 *   state
 *
 * Result: 302 to redirect_uri with ?code=<code>&state=<state>
 */
http.route({
  path: '/authorize',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url)
    const clientId = url.searchParams.get('client_id')
    const redirectUri = url.searchParams.get('redirect_uri')
    const codeChallenge = url.searchParams.get('code_challenge')
    const codeChallengeMethod = url.searchParams.get('code_challenge_method')
    const scope = url.searchParams.get('scope') ?? 'cccollab:topics.rw'
    const state = url.searchParams.get('state') ?? ''
    const responseType = url.searchParams.get('response_type')

    if (responseType !== 'code') return errorResponse(400, 'unsupported_response_type')
    if (!clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      return errorResponse(400, 'invalid_request', 'missing required params')
    }

    // Resolve Clerk identity. In production this uses Clerk's auth headers (via Convex auth).
    // In tests we fall back to X-Test-User-Id / X-Test-User-Name headers.
    const identity = await ctx.auth.getUserIdentity()
    let clerkId: string | null = identity?.subject ?? null
    let displayName: string | null = identity?.name ?? identity?.email ?? null
    let email: string | undefined = identity?.email ?? undefined
    if (!clerkId) {
      const testUserId = req.headers.get('x-test-user-id')
      const testUserName = req.headers.get('x-test-user-name')
      if (testUserId) {
        clerkId = testUserId
        displayName = testUserName ?? testUserId
      }
    }
    if (!clerkId || !displayName) {
      // Redirect to Clerk sign-in. For MVP we just return a hint page.
      return new Response(
        `<html><body>Sign in required. Please authenticate at your Clerk instance and retry.</body></html>`,
        { status: 401, headers: { 'Content-Type': 'text/html' } },
      )
    }

    const userId = await ctx.runMutation(api.users.getOrCreateByClerk, { clerkId, displayName, email })
    const { code } = await ctx.runMutation(api.oauth.authorize.issueAuthCode, {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: 'S256',
      scope,
      userId,
    })
    const redirect = new URL(redirectUri)
    redirect.searchParams.set('code', code)
    if (state) redirect.searchParams.set('state', state)
    return Response.redirect(redirect.toString(), 302)
  }),
})

http.route({
  path: '/token',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const form = await readFormBody(req)
    const grantType = form.get('grant_type')
    const clientId = form.get('client_id') ?? ''
    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? ''
      const codeVerifier = form.get('code_verifier') ?? ''
      const redirectUri = form.get('redirect_uri') ?? ''
      try {
        const tokens = await ctx.runAction(api.oauth.token.exchangeAuthCode, {
          clientId,
          code,
          codeVerifier,
          redirectUri,
        })
        return jsonResponse(tokens)
      } catch (err) {
        return errorResponse(400, 'invalid_grant', err instanceof Error ? err.message : 'error')
      }
    }
    if (grantType === 'refresh_token') {
      const refreshToken = form.get('refresh_token') ?? ''
      try {
        const tokens = await ctx.runAction(api.oauth.token.refreshAccessToken, {
          clientId,
          refreshToken,
        })
        return jsonResponse(tokens)
      } catch (err) {
        return errorResponse(400, 'invalid_grant', err instanceof Error ? err.message : 'error')
      }
    }
    return errorResponse(400, 'unsupported_grant_type')
  }),
})
```

- [ ] **Step 2: Commit**

```bash
git add convex/http.ts
git commit -m "feat(ccc-22): wire /authorize and /token HTTP endpoints"
```

---

## Phase 5: MCP Streamable HTTP transport + tools

### Task 17: MCP server dispatcher

**Files:**

- Create: `convex/mcp/server.ts`
- Create: `convex/mcp/tools/listTopics.ts`
- Create: `convex/mcp/tools/readTopic.ts`
- Create: `convex/mcp/tools/sendMessageToTopic.ts`

- [ ] **Step 1: Create tool definitions**

`convex/mcp/tools/listTopics.ts`:

```typescript
import type { GenericActionCtx } from 'convex/server'
import { api } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'

export const listTopicsTool = {
  name: 'list_topics',
  description: 'List active cccollab topics the authenticated user is a member of.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export async function handleListTopics(
  ctx: GenericActionCtx<any>,
  userId: Id<'users'>,
): Promise<{ topics: Array<{ id: string; name: string; channelId: string }> }> {
  const rows = await ctx.runQuery(api.topics.listForUser, { userId })
  return { topics: rows.map((t) => ({ id: t._id, name: t.name, channelId: t.channelId })) }
}
```

`convex/mcp/tools/readTopic.ts`:

```typescript
import type { GenericActionCtx } from 'convex/server'
import { api } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'

export const readTopicTool = {
  name: 'read_topic',
  description: 'Read a cccollab topic you are a member of, including its recent messages.',
  inputSchema: {
    type: 'object',
    properties: {
      topicId: { type: 'string', description: 'The topic id from list_topics.' },
    },
    required: ['topicId'],
    additionalProperties: false,
  },
}

export async function handleReadTopic(
  ctx: GenericActionCtx<any>,
  userId: Id<'users'>,
  args: { topicId: string },
): Promise<
  | { error: string }
  | {
      topic: { id: string; name: string; channelId: string }
      messages: Array<{ id: string; authorType: string; authorName: string; text: string; createdAt: number }>
    }
> {
  const result = await ctx.runQuery(api.topics.readForUser, {
    topicId: args.topicId as Id<'topics'>,
    userId,
  })
  if (!result) return { error: 'topic_not_found_or_not_a_member' }
  return {
    topic: { id: result.topic._id, name: result.topic.name, channelId: result.topic.channelId },
    messages: result.messages.map((m) => ({
      id: m._id,
      authorType: m.authorType,
      authorName: m.authorName,
      text: m.text,
      createdAt: m._creationTime,
    })),
  }
}
```

`convex/mcp/tools/sendMessageToTopic.ts`:

```typescript
import type { GenericActionCtx } from 'convex/server'
import { api } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'

export const sendMessageToTopicTool = {
  name: 'send_message_to_topic',
  description: 'Post a message to a cccollab topic you are a member of.',
  inputSchema: {
    type: 'object',
    properties: {
      topicId: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['topicId', 'text'],
    additionalProperties: false,
  },
}

export async function handleSendMessageToTopic(
  ctx: GenericActionCtx<any>,
  userId: Id<'users'>,
  args: { topicId: string; text: string },
): Promise<{ id: string } | { error: string }> {
  try {
    const messageId = await ctx.runMutation(api.messages.sendAsUser, {
      topicId: args.topicId as Id<'topics'>,
      userId,
      text: args.text,
    })
    return { id: messageId }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'error' }
  }
}
```

- [ ] **Step 2: Implement `convex/mcp/server.ts` dispatcher**

```typescript
import type { GenericActionCtx } from 'convex/server'
import type { Id } from '../_generated/dataModel'
import { listTopicsTool, handleListTopics } from './tools/listTopics'
import { readTopicTool, handleReadTopic } from './tools/readTopic'
import { sendMessageToTopicTool, handleSendMessageToTopic } from './tools/sendMessageToTopic'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

export const SERVER_INFO = {
  name: 'cccollab',
  version: '1.0.0',
}

export const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
}

const ALL_TOOLS = [listTopicsTool, readTopicTool, sendMessageToTopicTool]

export async function dispatchMcp(
  ctx: GenericActionCtx<any>,
  userId: Id<'users'>,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const { id = null, method, params } = request
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: SERVER_INFO,
          capabilities: SERVER_CAPABILITIES,
        },
      }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: ALL_TOOLS } }
    case 'tools/call': {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
      const name = p.name
      const args = p.arguments ?? {}
      let content: unknown
      switch (name) {
        case 'list_topics':
          content = await handleListTopics(ctx, userId)
          break
        case 'read_topic':
          content = await handleReadTopic(ctx, userId, args as { topicId: string })
          break
        case 'send_message_to_topic':
          content = await handleSendMessageToTopic(ctx, userId, args as { topicId: string; text: string })
          break
        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `unknown tool: ${name}` },
          }
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(content) }],
          isError: typeof content === 'object' && content !== null && 'error' in content,
        },
      }
    }
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add convex/mcp/
git commit -m "feat(ccc-22): mcp server dispatcher and three tools (list/read/send)"
```

### Task 18: MCP HTTP endpoint wired with bearer token auth

**Files:**

- Modify: `convex/http.ts`

- [ ] **Step 1: Add /mcp route to `convex/http.ts`**

```typescript
http.route({
  path: '/mcp',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = req.headers.get('authorization') ?? ''
    if (!auth.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer realm="cccollab mcp", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
        },
      })
    }
    const token = auth.slice('Bearer '.length)
    const tokenRow = await ctx.runQuery(internal.oauth.tokens.resolveAccessToken, { token })
    if (!tokenRow) {
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer error="invalid_token"`,
        },
      })
    }
    const body = await readJsonBody<any>(req)
    const { dispatchMcp } = await import('./mcp/server')
    const response = await dispatchMcp(ctx, tokenRow.userId, body)
    return jsonResponse(response)
  }),
})
```

- [ ] **Step 2: Commit**

```bash
git add convex/http.ts
git commit -m "feat(ccc-22): /mcp endpoint with bearer token auth + WWW-Authenticate challenge"
```

### Task 19: MCP endpoint integration test

**Files:**

- Create: `convex/tests/mcp.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'
import schema from '../schema'
import { api, internal } from '../_generated/api'
import { dispatchMcp } from '../mcp/server'

describe('mcp dispatcher', () => {
  it('initialize returns server info + capabilities', async () => {
    const t = convexTest(schema)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const res = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, userId, { jsonrpc: '2.0', id: 1, method: 'initialize' }),
    )
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'cccollab' } },
    })
  })

  it('tools/list returns three tools', async () => {
    const t = convexTest(schema)
    const userId = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'u', displayName: 'U' })
    const res = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, userId, { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    )
    const names = (res.result as any).tools.map((t: any) => t.name)
    expect(names.sort()).toEqual(['list_topics', 'read_topic', 'send_message_to_topic'])
  })

  it('tools/call list_topics returns only user-member topics', async () => {
    const t = convexTest(schema)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const bob = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'b', displayName: 'Bob' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    const aliceRes = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_topics', arguments: {} },
      }),
    )
    const aliceText = JSON.parse((aliceRes.result as any).content[0].text)
    expect(aliceText.topics.map((t: any) => t.name)).toEqual(['design'])

    const bobRes = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'list_topics', arguments: {} },
      }),
    )
    const bobText = JSON.parse((bobRes.result as any).content[0].text)
    expect(bobText.topics).toEqual([])
  })

  it('tools/call send_message_to_topic adds message attributed to external user', async () => {
    const t = convexTest(schema)
    const alice = await t.mutation(api.users.getOrCreateByClerk, { clerkId: 'a', displayName: 'Alice' })
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'c', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    const res = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'send_message_to_topic', arguments: { topicId, text: 'hi from alice' } },
      }),
    )
    const result = res.result as any
    expect(result.isError).toBeFalsy()

    const msgs = await t.query(api.messages.listForTopic, { topicId })
    expect(msgs).toMatchObject([{ authorType: 'external', authorName: 'Alice', text: 'hi from alice' }])
  })
})
```

- [ ] **Step 2: Run tests**

Run: `yarn vitest run convex/tests/mcp.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add convex/tests/mcp.test.ts
git commit -m "test(ccc-22): integration tests for MCP dispatcher (initialize, tools/list, tools/call)"
```

---

## Phase 6: Plugin bridge (Convex -> local broker)

### Task 20: Convex bridge

**Files:**

- Create: `src/bridge/convex-bridge.ts`
- Create: `tests/bridge.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/bridge.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildLocalEventPayload, type ConvexMessageRow } from '../src/bridge/convex-bridge'

describe('convex bridge', () => {
  it('translates a Convex message row into a local broker /local-event payload', () => {
    const row: ConvexMessageRow = {
      _id: 'msg_1' as any,
      _creationTime: 1700000000000,
      topicId: 'topic_1' as any,
      authorType: 'external',
      authorKey: 'clerk_abc',
      authorName: 'Alice',
      text: 'hello world',
    }
    const payload = buildLocalEventPayload(row, { topicName: 'design', channel: 'eng' })
    expect(payload).toEqual({
      type: 'message',
      channel: 'eng',
      topicId: 'topic_1',
      topicName: 'design',
      sender: 'Alice',
      authorType: 'external',
      text: 'hello world',
      ts: new Date(1700000000000).toISOString(),
    })
  })
})
```

- [ ] **Step 2: Write `src/bridge/convex-bridge.ts`**

```typescript
import { ConvexClient } from 'convex/browser'

export type ConvexMessageRow = {
  _id: string
  _creationTime: number
  topicId: string
  authorType: 'session' | 'external'
  authorKey: string
  authorName: string
  text: string
}

export type TopicContext = {
  topicName: string
  channel: string
}

export type LocalEventPayload = {
  type: 'message'
  channel: string
  topicId: string
  topicName: string
  sender: string
  authorType: 'session' | 'external'
  text: string
  ts: string
}

export function buildLocalEventPayload(row: ConvexMessageRow, ctx: TopicContext): LocalEventPayload {
  return {
    type: 'message',
    channel: ctx.channel,
    topicId: row.topicId,
    topicName: ctx.topicName,
    sender: row.authorName,
    authorType: row.authorType,
    text: row.text,
    ts: new Date(row._creationTime).toISOString(),
  }
}

export interface BridgeOptions {
  convexUrl: string
  brokerUrl: string
  /** Optional bearer token if the Convex backend exposes queries over HTTP w/ auth. */
  accessToken?: string
}

export interface BridgeHandle {
  stop(): Promise<void>
}

/**
 * Start a bridge that subscribes to Convex messages (for all topics visible to the bridge's
 * authenticated context) and forwards each new message to the local broker as a /local-event.
 *
 * This is a thin forwarder: membership scoping is handled server-side by Convex queries.
 */
export async function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const client = new ConvexClient(opts.convexUrl)
  if (opts.accessToken) {
    // @ts-expect-error Convex client supports setAuth
    client.setAuth(() => Promise.resolve(opts.accessToken))
  }
  const seen = new Set<string>()
  const unsubscribe = client.onUpdate('messages:listRecent' as any, {}, async (rows: ConvexMessageRow[]) => {
    for (const row of rows) {
      if (seen.has(row._id)) continue
      seen.add(row._id)
      const payload = buildLocalEventPayload(row, {
        topicName: row.topicId,
        channel: 'external',
      })
      await fetch(`${opts.brokerUrl}/local-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {
        /* best-effort */
      })
    }
  })
  return {
    async stop() {
      unsubscribe()
      await client.close()
    },
  }
}
```

- [ ] **Step 3: Pass test**

Run: `yarn vitest run tests/bridge.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/bridge/ tests/bridge.test.ts
git commit -m "feat(ccc-22): convex-to-broker bridge + test for payload translation"
```

### Task 21: Add `listRecent` query for bridge

**Files:**

- Modify: `convex/messages.ts`

- [ ] **Step 1: Add `listRecent` query**

Append to `convex/messages.ts`:

```typescript
export const listRecent = query({
  args: {},
  handler: async (ctx): Promise<Doc<'messages'>[]> => {
    return await ctx.db.query('messages').order('desc').take(50)
  },
})
```

- [ ] **Step 2: Commit**

```bash
git add convex/messages.ts
git commit -m "feat(ccc-22): messages.listRecent query for the bridge"
```

---

## Phase 7: Scenario tests

### Task 22: Scenario harness

**Files:**

- Create: `tests/scenarios/harness.ts`

The harness uses `convex-test` to run Convex functions in-memory, then hands us a `MockFetch` function we can use to call the HTTP endpoints (simulating external clients). It supplies a helper to register a fake Clerk identity.

- [ ] **Step 1: Implement harness**

```typescript
// tests/scenarios/harness.ts
import { convexTest } from 'convex-test'
import schema from '../../convex/schema'
import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'

export async function makeHarness() {
  const t = convexTest(schema)
  async function withFakeIdentity<T>(
    identity: { subject: string; name?: string; email?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const asIdentity = t.withIdentity({
      issuer: 'https://test.clerk',
      tokenIdentifier: `https://test.clerk|${identity.subject}`,
      subject: identity.subject,
      name: identity.name,
      email: identity.email,
    } as any)
    // Monkey-patch t's default client for this scope
    const origMutation = t.mutation.bind(t)
    const origQuery = t.query.bind(t)
    const origAction = t.action.bind(t)
    t.mutation = asIdentity.mutation.bind(asIdentity) as any
    t.query = asIdentity.query.bind(asIdentity) as any
    t.action = asIdentity.action.bind(asIdentity) as any
    try {
      return await fn()
    } finally {
      t.mutation = origMutation as any
      t.query = origQuery as any
      t.action = origAction as any
    }
  }

  async function ensureUser(clerkId: string, name: string, email?: string): Promise<Id<'users'>> {
    return await t.mutation(api.users.getOrCreateByClerk, { clerkId, displayName: name, email })
  }

  return {
    t,
    withFakeIdentity,
    ensureUser,
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/scenarios/harness.ts
git commit -m "test(ccc-22): scenario test harness with fake Clerk identities"
```

### Task 23: OAuth flow scenario test

**Files:**

- Create: `tests/scenarios/oauth-flow.scenario.test.ts`

- [ ] **Step 1: Write scenario**

```typescript
import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness'
import { api } from '../../convex/_generated/api'
import { sha256Base64Url } from '../../convex/lib/crypto'

describe('Scenario: OAuth 2.1 flow', () => {
  it('client can register, obtain auth code, exchange for access + refresh tokens, refresh tokens', async () => {
    const { t, ensureUser } = await makeHarness()
    const userId = await ensureUser('clerk_alice', 'Alice', 'alice@example.com')

    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'Scenario Client',
      redirectUris: ['http://localhost:9999/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    expect(client.client_id).toBeDefined()

    const verifier = 'super-secret-verifier-abc123'
    const challenge = await sha256Base64Url(verifier)

    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:9999/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    expect(code).toBeDefined()

    const tokens = await t.action(api.oauth.token.exchangeAuthCode, {
      clientId: client.client_id,
      code,
      codeVerifier: verifier,
      redirectUri: 'http://localhost:9999/cb',
    })
    expect(tokens.token_type).toBe('Bearer')
    expect(tokens.access_token).toBeDefined()
    expect(tokens.refresh_token).toBeDefined()

    const refreshed = await t.action(api.oauth.token.refreshAccessToken, {
      clientId: client.client_id,
      refreshToken: tokens.refresh_token,
    })
    expect(refreshed.access_token).toBeDefined()
    expect(refreshed.access_token).not.toBe(tokens.access_token)
  })

  it('rejects code exchange with wrong PKCE verifier', async () => {
    const { t, ensureUser } = await makeHarness()
    const userId = await ensureUser('clerk_alice', 'Alice')
    const client = await t.mutation(api.oauth.register.register, {
      clientName: 'x',
      redirectUris: ['http://localhost:9999/cb'],
      tokenEndpointAuthMethod: 'none',
    })
    const challenge = await sha256Base64Url('correct-verifier')
    const { code } = await t.mutation(api.oauth.authorize.issueAuthCode, {
      clientId: client.client_id,
      redirectUri: 'http://localhost:9999/cb',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      scope: 'cccollab:topics.rw',
      userId,
    })
    await expect(
      t.action(api.oauth.token.exchangeAuthCode, {
        clientId: client.client_id,
        code,
        codeVerifier: 'wrong-verifier',
        redirectUri: 'http://localhost:9999/cb',
      }),
    ).rejects.toThrow(/pkce|verifier/i)
  })
})
```

- [ ] **Step 2: Run, verify pass**

Run: `yarn vitest run tests/scenarios/oauth-flow.scenario.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/scenarios/oauth-flow.scenario.test.ts
git commit -m "test(ccc-22): scenario test for OAuth 2.1 flow (register + authorize + token + refresh)"
```

### Task 24: MCP tool scenario test (list/read/send)

**Files:**

- Create: `tests/scenarios/mcp-tools.scenario.test.ts`

- [ ] **Step 1: Write scenario**

```typescript
import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness'
import { api } from '../../convex/_generated/api'
import { dispatchMcp } from '../../convex/mcp/server'

describe('Scenario: MCP tools end-to-end', () => {
  it('external AI can list, read, and send messages to topics it is a member of', async () => {
    const { t, ensureUser } = await makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design-review', channelId, creatorUserId: alice })

    // list_topics
    const listRes = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_topics', arguments: {} },
      }),
    )
    const listed = JSON.parse((listRes.result as any).content[0].text)
    expect(listed.topics.length).toBe(1)
    expect(listed.topics[0].name).toBe('design-review')

    // send_message_to_topic
    const sendRes = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'send_message_to_topic', arguments: { topicId, text: 'hello team' } },
      }),
    )
    expect((sendRes.result as any).isError).toBeFalsy()

    // read_topic shows the message
    const readRes = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_topic', arguments: { topicId } },
      }),
    )
    const read = JSON.parse((readRes.result as any).content[0].text)
    expect(read.messages.length).toBe(1)
    expect(read.messages[0].text).toBe('hello team')
    expect(read.messages[0].authorType).toBe('external')
    expect(read.messages[0].authorName).toBe('Alice')
  })
})
```

- [ ] **Step 2: Pass**

Run: `yarn vitest run tests/scenarios/mcp-tools.scenario.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/scenarios/mcp-tools.scenario.test.ts
git commit -m "test(ccc-22): scenario test for MCP tools list/read/send end-to-end"
```

### Task 25: Attribution scenario test

**Files:**

- Create: `tests/scenarios/attribution.scenario.test.ts`

- [ ] **Step 1: Scenario**

```typescript
import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness'
import { api } from '../../convex/_generated/api'
import { dispatchMcp } from '../../convex/mcp/server'

describe('Scenario: attribution', () => {
  it('messages posted via MCP are attributed to the external user, not the developer or a generic sender', async () => {
    const { t, ensureUser } = await makeHarness()
    const developer = await ensureUser('clerk_dev', 'Dev Person')
    const externalAlice = await ensureUser('clerk_alice', 'Alice External')

    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: developer })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: developer })

    // Alice joins the topic (developer invites her - modelled by inserting membership).
    await t.mutation(api.topics.join, { topicId, userId: externalAlice })

    // Developer sends a session message (simulated direct insert).
    await t.mutation(api.messages.send, {
      topicId,
      authorType: 'session',
      authorKey: 'dev-session',
      authorName: 'Developer Session',
      text: 'kicking off',
    })

    // Alice sends via MCP
    const res = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, externalAlice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_message_to_topic', arguments: { topicId, text: 'my take' } },
      }),
    )
    expect((res.result as any).isError).toBeFalsy()

    const messages = await t.query(api.messages.listForTopic, { topicId })
    const alicesMessage = messages.find((m) => m.text === 'my take')
    expect(alicesMessage).toBeDefined()
    expect(alicesMessage!.authorType).toBe('external')
    expect(alicesMessage!.authorName).toBe('Alice External')
    expect(alicesMessage!.authorName).not.toBe('Developer Session')
    expect(alicesMessage!.authorName).not.toBe('external')
  })
})
```

- [ ] **Step 2: Pass + commit**

Run: `yarn vitest run tests/scenarios/attribution.scenario.test.ts`
Expected: PASS

```bash
git add tests/scenarios/attribution.scenario.test.ts
git commit -m "test(ccc-22): scenario test for message attribution (external user, not generic)"
```

### Task 26: Cross-visibility scenario test (external -> Claude Code via bridge)

**Files:**

- Create: `tests/scenarios/cross-visibility.scenario.test.ts`

- [ ] **Step 1: Scenario — exercises the bridge transformer**

```typescript
import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness'
import { api } from '../../convex/_generated/api'
import { dispatchMcp } from '../../convex/mcp/server'
import { buildLocalEventPayload, type ConvexMessageRow } from '../../src/bridge/convex-bridge'

describe('Scenario: cross-visibility (external -> Claude Code via bridge)', () => {
  it('message sent via MCP is translated into a local-event the broker can broadcast', async () => {
    const { t, ensureUser } = await makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    await t.run(async (ctx: any) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_message_to_topic', arguments: { topicId, text: 'from external' } },
      }),
    )

    const messages = await t.query(api.messages.listForTopic, { topicId })
    expect(messages.length).toBe(1)

    const row: ConvexMessageRow = {
      _id: messages[0]._id,
      _creationTime: messages[0]._creationTime,
      topicId: messages[0].topicId,
      authorType: messages[0].authorType,
      authorKey: messages[0].authorKey,
      authorName: messages[0].authorName,
      text: messages[0].text,
    }

    const payload = buildLocalEventPayload(row, { topicName: 'design', channel: 'eng' })
    expect(payload).toMatchObject({
      type: 'message',
      channel: 'eng',
      topicName: 'design',
      sender: 'Alice',
      authorType: 'external',
      text: 'from external',
    })
  })

  it('message sent by a developer session is visible to MCP read_topic', async () => {
    const { t, ensureUser } = await makeHarness()
    const alice = await ensureUser('clerk_alice', 'Alice')
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    // Simulate a message written by a Claude Code session (session author).
    await t.mutation(api.messages.send, {
      topicId,
      authorType: 'session',
      authorKey: 'dev-1',
      authorName: 'reviewer',
      text: 'dev wrote this',
    })

    const res = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, alice, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_topic', arguments: { topicId } },
      }),
    )
    const read = JSON.parse((res.result as any).content[0].text)
    expect(read.messages.length).toBe(1)
    expect(read.messages[0].authorName).toBe('reviewer')
    expect(read.messages[0].authorType).toBe('session')
    expect(read.messages[0].text).toBe('dev wrote this')
  })
})
```

- [ ] **Step 2: Pass + commit**

Run: `yarn vitest run tests/scenarios/cross-visibility.scenario.test.ts`
Expected: PASS

```bash
git add tests/scenarios/cross-visibility.scenario.test.ts
git commit -m "test(ccc-22): scenario tests for cross-visibility between external + session authors"
```

### Task 27: Scoping scenario test

**Files:**

- Create: `tests/scenarios/scoping.scenario.test.ts`

- [ ] **Step 1: Scenario**

```typescript
import { describe, it, expect } from 'vitest'
import { makeHarness } from './harness'
import { api } from '../../convex/_generated/api'
import { dispatchMcp } from '../../convex/mcp/server'

describe('Scenario: per-user scoping', () => {
  it('a user cannot list, read, or send to a topic they are not a member of', async () => {
    const { t, ensureUser } = await makeHarness()
    const alice = await ensureUser('clerk_a', 'Alice')
    const bob = await ensureUser('clerk_b', 'Bob')
    const channelId = await t.mutation(api.channels.getOrCreate, { name: 'eng', creatorUserId: alice })
    const topicId = await t.mutation(api.topics.create, { name: 'design', channelId, creatorUserId: alice })

    // Bob is not a member of this topic.

    const list = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_topics', arguments: {} },
      }),
    )
    const listed = JSON.parse((list.result as any).content[0].text)
    expect(listed.topics).toEqual([])

    const read = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'read_topic', arguments: { topicId } },
      }),
    )
    const readParsed = JSON.parse((read.result as any).content[0].text)
    expect(readParsed.error).toBe('topic_not_found_or_not_a_member')

    const send = await t.run(async (ctx: any) =>
      dispatchMcp(ctx, bob, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'send_message_to_topic', arguments: { topicId, text: 'sneak in' } },
      }),
    )
    const sendParsed = JSON.parse((send.result as any).content[0].text)
    expect(sendParsed.error).toMatch(/not a member/i)
  })
})
```

- [ ] **Step 2: Pass + commit**

Run: `yarn vitest run tests/scenarios/scoping.scenario.test.ts`
Expected: PASS

```bash
git add tests/scenarios/scoping.scenario.test.ts
git commit -m "test(ccc-22): scenario test for per-user scoping (non-members blocked)"
```

---

## Phase 8: Docs + CI

### Task 28: README + deployment docs

**Files:**

- Create: `docs/CCC-22-http-mcp.md`
- Modify: `README.md`

- [ ] **Step 1: Write `docs/CCC-22-http-mcp.md`** with sections:
  - Overview
  - Deployment (Convex + Clerk setup steps)
  - Registering an AI client (example curl)
  - Obtaining tokens (example auth URL + exchange)
  - Configuring Claude.ai / Cursor / ChatGPT to use the server
  - Running the optional bridge locally

- [ ] **Step 2: Add short pointer in `README.md`**

Append a section "HTTP MCP server" with a 3-line intro + link to `docs/CCC-22-http-mcp.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/CCC-22-http-mcp.md README.md
git commit -m "docs(ccc-22): http mcp server + bridge setup guide"
```

### Task 29: Ensure tests run in CI; adjust vitest config

**Files:**

- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Point vitest at both `tests/` and `convex/tests/`**

Update `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'convex/tests/**/*.test.ts'],
    environmentMatchGlobs: [['convex/tests/**', 'edge-runtime']],
    server: { deps: { inline: ['convex-test'] } },
  },
})
```

- [ ] **Step 2: Run full suite**

Run: `yarn test`
Expected: all pass (pre-existing + new).

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "chore(ccc-22): wire vitest to run convex tests (edge runtime) and new scenarios"
```

### Task 30: Final smoke + release notes

**Files:**

- Modify: (depends on findings)

- [ ] **Step 1: Run typecheck + full test suite**

```bash
yarn tsc --noEmit
yarn test
yarn lint
```

- [ ] **Step 2: Address any warnings or errors**

- [ ] **Step 3: Push branch**

```bash
git push -u origin feature/ccc-22-http-mcp-server
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat(ccc-22): external LLMs participate in topics via hosted HTTP MCP server" --body "<see PR body>"
```

PR body includes:

- Summary of ACs satisfied
- What's deferred (deployment to `cccollab.flatout.solutions/mcp`, CCC-3 plugin migration)
- Test plan: OAuth flow, scoping, attribution, cross-visibility scenario tests

---

## Done criteria

- [ ] All 6 acceptance criteria from CCC-22 verifiable by scenario tests in `tests/scenarios/`.
- [ ] `yarn test` passes cleanly.
- [ ] `yarn tsc --noEmit` passes.
- [ ] `yarn lint` passes.
- [ ] PR created and Jira updated.
