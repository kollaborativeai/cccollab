# cccollab → KAI Merge: Phase 2 — MCP Server Clerk Auth + Wire Compat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `@flatoutsolutions/cccollab` MCP server able to authenticate against KAI's Convex deployment using Clerk OAuth (Authorization Code + PKCE), and align KAI's Phase-1 cccollab Convex functions with what the MCP server actually calls. After this phase, pointing the MCP server at KAI's Convex URL "just works" against a Clerk identity.

**Architecture:** OAuth 2.0 Authorization Code + PKCE flow against Clerk directly (no client secret, no federation layer). The MCP server holds Clerk-issued JWTs minted from the `convex` template; Convex SDK `setAuth(refreshFn)` handles the ~1min token rotation. Both auth flows (existing Convex Auth and new Clerk) coexist via a discriminated-union `authType` field on each location — no break for current users. KAI's Convex functions get small wire-compat adjustments (signature alignment, cursor consultation, denormalized sender for message tombstones, user-delete cascade hook).

**Tech Stack:** Node.js (cccollab MCP server), Convex 1.34+, TypeScript, Vitest, Clerk (auth provider), KAI's existing `convexAuth(ctx)` helper.

---

## Spans two repos

| Repo | Path | What changes |
|---|---|---|
| **KAI** | `/Users/sandhu/Documents/Projects/kollaborativeai/` | Part A tasks: wire-compat to cccollab Convex functions, message tombstones, user-delete cascade, ESLint rule |
| **cccollab** | `/Users/sandhu/Documents/Projects/cccollab/` | Part B tasks: PKCE auth flow, discriminated config, transport `setAuth` callback, authenticate tool |

Parts A and B are largely independent; A's changes are visible only to clients that use them. Part B can begin in parallel once Part A's `topics.listByChannel` signature stabilizes. Recommended order: A1-A9, then B0-B9.

## Out of Scope

- `organizationId` on cccollab tables (Phase 3)
- Two-tier access checks gated on KAI org membership (Phase 3)
- KAI web UI for cccollab channels/topics (Phase 4)
- Sunset of standalone cccollab Convex deployment (Phase 5)
- Deletion of `@convex-dev/auth` from cccollab repo (Phase 5)

Phase 2 deliberately keeps **both** auth paths working side-by-side. The existing Google/Convex Auth flow continues to work for standalone deployments during the transition.

## Success Criteria

1. KAI Convex (Phase 1 branch + this plan's Part A changes) deploys clean, full test suite passes.
2. cccollab MCP server, configured with a `clerk` location pointing at KAI's Convex URL, can:
   - Run `authenticate` and open a browser to Clerk's authorize endpoint
   - Capture the authorization code via the existing loopback listener
   - Exchange the code for Clerk access + refresh tokens
   - Persist tokens to `~/.cccollab/config.json` mode 0600
   - Use the access token to call KAI's cccollab Convex functions (`introduce`, `whoami`, `join`, `start`, etc.)
   - Automatically refresh expired tokens via Convex SDK's `setAuth` callback — reactive subscriptions stay alive across token rotations
3. Existing Convex Auth flow continues to work for `convex-google` locations (no regression).
4. KAI user deletion cascades to cccollab tables (sessions, memberships) but preserves messages with denormalized sender info.
5. `messages.listByChannel` returns only the right messages when a `sessionId` cursor is supplied (no replay).
6. `topics.listByChannel` callable via the signature the MCP server passes.
7. DM `ts` strictly monotonic per recipient — no millisecond collisions.

---

## File Structure

### KAI repo changes

```
frontend/src/convex/
├── models/
│   └── cccollabMessages.ts                   # MODIFY: add senderName, senderAvatarUrl fields
├── cccollab/
│   ├── messages.ts                           # MODIFY: populate sender denorm; add sessionId cursor arg; allocate DM ts monotonically
│   ├── messages.test.ts                      # MODIFY: cover tombstone, cursor consultation, DM ts monotonicity, DM name ambiguity
│   ├── topics.ts                             # MODIFY: listByChannel accepts channelName variant
│   ├── topics.test.ts                        # MODIFY: cover the channel-name variant
│   └── helpers.ts                            # MODIFY: add allocateRecipientTs helper
└── clerk.webhook.ts                          # MODIFY: user.deleted cascades to cccollab tables
```

ESLint rule lives at the workspace level — file path TBD per Task A7.

### cccollab repo changes

```
mcp_server/src/
├── remote/
│   ├── auth.ts                               # MODIFY: branch on authType; existing convex-google flow stays; add Clerk PKCE branch
│   ├── auth-clerk.ts                         # CREATE: Clerk PKCE flow (verifier gen, authorize URL, token exchange, refresh)
│   ├── auth-clerk.test.ts                    # CREATE: unit tests for PKCE primitives + mocked HTTP token exchange
│   └── browser.ts                            # UNCHANGED — reused as-is
├── config/
│   ├── schema.ts                             # MODIFY: add authType discriminated-union field
│   └── schema.test.ts                        # MODIFY (or CREATE): validate the new shape
├── transport/
│   └── remote.ts                             # MODIFY: setAuth refresh callback for clerk locations
└── tools/
    └── identity.ts                           # MODIFY: authenticate tool branches on authType
```

Plus one-time human action:

```
docs/architecture/clerk-auth-setup.md         # CREATE: Clerk Dashboard checklist
```

---

## Naming and Conventions

- **Error codes**: structured `ConvexError({ code: 'UPPER_SNAKE', message: '...' })` everywhere (Phase 1 convention, enforced by Task A7 ESLint rule)
- **`authType` enum values**: `'convex-google'` (existing) and `'clerk'` (new)
- **Clerk client ID**: `cccollab-cli` (matches kai-dev's proposal)
- **Loopback callback path**: `/cccollab-oauth-callback` (matches cccollab's existing `mcp_server/src/remote/auth.ts:25-26` path; reused verbatim)
- **JWT template name**: `convex` (the standard Clerk template for Convex integration)
- **Tests**: Vitest for both repos. KAI cccollab tests under `frontend/src/convex/cccollab/*.test.ts` (edge-runtime via project config); cccollab MCP server tests use node environment.

---

# PART A — KAI Repo Wire Compat

Working directory for all Part A tasks: a worktree on KAI based on `feat/cccollab-phase1-schema-lift` (already merged to main, or branched fresh from main once Phase 1 PR lands).

**Branch suggestion:** `feat/cccollab-phase2a-wire-compat`

## Task A1: Schema — denormalized sender fields on cccollabMessages

**Files:**
- Modify: `frontend/src/convex/models/cccollabMessages.ts`

**Why:** Messages must survive sender deletion. Denormalizing `senderName` and `senderAvatarUrl` at write time means "[deleted user]" rendering Just Works after Task A3's cascade.

- [ ] **Step 1: Add fields to schema**

Update `frontend/src/convex/models/cccollabMessages.ts` — add two optional fields. They're optional in this task because Phase-1-era rows don't have them yet; Task A2 will populate them on every new write. A future task can make them required after backfill.

```typescript
import { defineTable } from 'convex/server'
import { v } from 'convex/values'

export const cccollabMessages = defineTable({
  kind: v.union(v.literal('topic'), v.literal('broadcast'), v.literal('direct')),
  topicId: v.optional(v.id('cccollabTopics')),
  channelId: v.optional(v.id('cccollabChannels')),
  fromSessionId: v.id('cccollabSessions'),
  fromUserId: v.id('users'),
  toSessionId: v.optional(v.id('cccollabSessions')),
  // Denormalized sender identity captured at write time. Survives user deletion
  // so chat history renders coherently. Profile renames do NOT retro-rewrite
  // historical messages.
  senderName: v.optional(v.string()),
  senderAvatarUrl: v.optional(v.string()),
  text: v.string(),
  ts: v.number(),
})
  .index('by_topic_and_ts', ['topicId', 'ts'])
  .index('by_channel_and_ts', ['channelId', 'ts'])
  .index('by_toSessionId_and_ts', ['toSessionId', 'ts'])
```

- [ ] **Step 2: Verify codegen + typecheck**

```bash
cd /path/to/kai-worktree/frontend
npx convex codegen --typecheck disable
yarn tsc --noEmit
yarn test --run
```

Expected: typecheck clean; 202 existing tests still pass (existing tests don't reference these new optional fields yet).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/convex/models/cccollabMessages.ts
git commit -m "$(cat <<'EOF'
feat(cccollab): add senderName/senderAvatarUrl to cccollabMessages

Denormalized sender identity captured at write time so chat history
survives sender deletion coherently. Fields are optional until Task A2
populates them on every new write.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task A2: Populate sender denorm in send mutations

**Files:**
- Modify: `frontend/src/convex/cccollab/messages.ts`
- Modify: `frontend/src/convex/cccollab/messages.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `frontend/src/convex/cccollab/messages.test.ts`, inside the existing `sendToTopic` describe block:

```typescript
  test('captures senderName + senderAvatarUrl on the message', async () => {
    const t = convexTest(schema, modules)
    const { sessionId, topicId } = await setupTopic(t, 'u1', 'alice', 'dev', 'plan')

    // Patch the user to have a name and avatar so we can verify denorm
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query('users')
        .withIndex('by_clerkId', (q) => q.eq('clerkId', 'u1'))
        .unique()
      await ctx.db.patch(user!._id, {
        name: 'Alice Anderson',
        avatarUrl: 'https://example.com/alice.png',
      })
    })

    const as = t.withIdentity({ subject: 'u1' })
    const { messageId } = await as.mutation(api.cccollab.messages.sendToTopic, {
      sessionId,
      topicId,
      text: 'hi',
    })
    const msg = await t.run(async (ctx) => await ctx.db.get(messageId))
    expect(msg?.senderName).toBe('Alice Anderson')
    expect(msg?.senderAvatarUrl).toBe('https://example.com/alice.png')
  })
```

Repeat the same assertion under `sendToChannel` and `sendToSession` describe blocks (three tests total).

- [ ] **Step 2: Verify tests fail**

```bash
cd /path/to/kai-worktree/frontend
yarn test src/convex/cccollab/messages.test.ts --run
```

Expected: 3 new failures.

- [ ] **Step 3: Update send mutations to populate denorm fields**

In `frontend/src/convex/cccollab/messages.ts`, every `ctx.db.insert('cccollabMessages', { ... })` call site needs to add `senderName: user.name` and `senderAvatarUrl: user.avatarUrl`. There are three call sites: `sendToTopic`, `sendToChannel`, `sendToSession`. Pattern:

```typescript
const messageId = await ctx.db.insert('cccollabMessages', {
  kind: 'topic',
  topicId: args.topicId,
  channelId: topic.channelId,
  fromSessionId: args.sessionId,
  fromUserId: user._id,
  senderName: user.name,
  senderAvatarUrl: user.avatarUrl,
  text: args.text,
  ts,
})
```

- [ ] **Step 4: Verify tests pass**

```bash
yarn test --run
```

Expected: 205 total tests (202 + 3 new), all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/convex/cccollab/messages.ts frontend/src/convex/cccollab/messages.test.ts
git commit -m "$(cat <<'EOF'
feat(cccollab): denormalize sender name/avatar onto messages

sendToTopic, sendToChannel, sendToSession all capture user.name and
user.avatarUrl at write time. Survives sender deletion (Task A3
cascade leaves messages intact).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task A3: User-deleted cascade

**Files:**
- Modify: `frontend/src/convex/clerk.webhook.ts`
- Possibly create: `frontend/src/convex/clerk.webhook.test.ts` (verify if exists)

**Why:** When Clerk webhook deletes a KAI user (via `user.deleted` event), orphan FK rows in cccollab tables point at the deleted user. Sessions reaping cascades through `sessions.remove`; cleanup the user-level rows.

- [ ] **Step 1: Read existing clerk.webhook.ts**

Locate the `user.deleted` handler. The current handler deletes the user row; you'll extend it to first clean up cccollab rows.

- [ ] **Step 2: Write failing test**

If `frontend/src/convex/clerk.webhook.test.ts` exists, append. Otherwise create it. Test:

```typescript
import { convexTest } from 'convex-test'
import { describe, expect, test } from 'vitest'
import schema from './schema'
import modules from './testModules'
// import the deletion handler — typically an internal mutation
import { internal } from './_generated/api'

describe('clerk.webhook user.deleted', () => {
  test('cascades to cccollab sessions, memberships, presence; leaves messages', async () => {
    const t = convexTest(schema, modules)

    const { userId, sessionId, channelId, topicId, messageId } = await t.run(
      async (ctx) => {
        const userId = await ctx.db.insert('users', {
          clerkId: 'user_to_delete',
          email: 'gone@example.com',
          name: 'Soon Deleted',
        })
        const channelId = await ctx.db.insert('cccollabChannels', {
          name: 'dev',
          normalizedName: 'dev',
          createdAt: Date.now(),
        })
        const sessionId = await ctx.db.insert('cccollabSessions', {
          userId,
          sessionName: 'alice',
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
        })
        await ctx.db.insert('cccollabChannelMembers', {
          userId,
          channelId,
          joinedAt: Date.now(),
        })
        await ctx.db.insert('cccollabSessionChannels', {
          sessionId,
          channelId,
          joinedAt: Date.now(),
        })
        const topicId = await ctx.db.insert('cccollabTopics', {
          channelId,
          topic: 'plan',
          normalizedTopic: 'plan',
          creatorSessionId: sessionId,
          state: 'active',
          createdAt: Date.now(),
        })
        await ctx.db.insert('cccollabTopicMembers', {
          topicId,
          sessionId,
          joinedAt: Date.now(),
        })
        const messageId = await ctx.db.insert('cccollabMessages', {
          kind: 'topic',
          topicId,
          channelId,
          fromSessionId: sessionId,
          fromUserId: userId,
          senderName: 'Soon Deleted',
          text: 'last message',
          ts: Date.now(),
        })
        return { userId, sessionId, channelId, topicId, messageId }
      }
    )

    // Trigger the user-delete cascade (the exact internal mutation depends on
    // how clerk.webhook is structured — update the import path accordingly)
    await t.mutation(internal.users.deleteUserCascade ?? internal.clerk.webhook.handleUserDeleted, {
      clerkId: 'user_to_delete',
    })

    // Sessions, memberships, presence: gone
    const user = await t.run(async (ctx) => await ctx.db.get(userId))
    const session = await t.run(async (ctx) => await ctx.db.get(sessionId))
    const channelMember = await t.run(
      async (ctx) =>
        await ctx.db
          .query('cccollabChannelMembers')
          .withIndex('by_user', (q) => q.eq('userId', userId))
          .unique()
    )
    const sessionChannel = await t.run(
      async (ctx) =>
        await ctx.db
          .query('cccollabSessionChannels')
          .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
          .unique()
    )
    const topicMember = await t.run(
      async (ctx) =>
        await ctx.db
          .query('cccollabTopicMembers')
          .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
          .unique()
    )
    expect(user).toBeNull()
    expect(session).toBeNull()
    expect(channelMember).toBeNull()
    expect(sessionChannel).toBeNull()
    expect(topicMember).toBeNull()

    // Message tombstone: kept, with denorm sender intact
    const message = await t.run(async (ctx) => await ctx.db.get(messageId))
    expect(message).not.toBeNull()
    expect(message?.senderName).toBe('Soon Deleted')

    // Channels and topics: NOT deleted (they outlive their creator)
    const channel = await t.run(async (ctx) => await ctx.db.get(channelId))
    const topic = await t.run(async (ctx) => await ctx.db.get(topicId))
    expect(channel).not.toBeNull()
    expect(topic).not.toBeNull()
  })
})
```

The `?? internal.clerk.webhook.handleUserDeleted` part hedges on the actual internal-mutation path; the implementer should resolve to the real one.

- [ ] **Step 3: Run — expect FAIL**

```bash
yarn test src/convex/clerk.webhook.test.ts --run
```

- [ ] **Step 4: Implement cascade in clerk.webhook.ts**

Read the existing user.deleted handler. Before deleting the user row, query and delete:

```typescript
async function cascadeCccollabRowsForUser(ctx: MutationCtx, userId: Id<'users'>) {
  // 1. All sessions owned by this user (drives further cascades)
  const sessions = await ctx.db
    .query('cccollabSessions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()

  for (const session of sessions) {
    // Topic memberships
    const topicMembers = await ctx.db
      .query('cccollabTopicMembers')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect()
    for (const tm of topicMembers) await ctx.db.delete(tm._id)

    // Session-level channel presence
    const presence = await ctx.db
      .query('cccollabSessionChannels')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect()
    for (const p of presence) await ctx.db.delete(p._id)

    // The session itself
    await ctx.db.delete(session._id)
  }

  // 2. User-level channel memberships
  const memberships = await ctx.db
    .query('cccollabChannelMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  for (const m of memberships) await ctx.db.delete(m._id)

  // 3. Read cursors
  const cursors = await ctx.db
    .query('cccollabChannelReadCursors')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  for (const c of cursors) await ctx.db.delete(c._id)

  // NOTE: cccollabMessages are intentionally NOT deleted. Denormalized
  // senderName/senderAvatarUrl let the UI render "[deleted user]: ..."
  // coherently.
}
```

Call `await cascadeCccollabRowsForUser(ctx, userId)` BEFORE the existing `ctx.db.delete(userId)` in the user.deleted handler.

- [ ] **Step 5: Verify tests pass**

```bash
yarn test --run
```

Expected: 206 total tests (205 + 1 new), all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/convex/clerk.webhook.ts frontend/src/convex/clerk.webhook.test.ts
git commit -m "$(cat <<'EOF'
feat(cccollab): cascade-delete cccollab rows on user.deleted

When the Clerk webhook deletes a KAI user, drop their cccollab
sessions, channel memberships, session presence, topic memberships,
and read cursors. Messages are kept — the denorm senderName from
Task A2 lets UI render '[deleted user]' coherently.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task A4: topics.listByChannel — support channel-name variant

**Files:**
- Modify: `frontend/src/convex/cccollab/topics.ts`
- Modify: `frontend/src/convex/cccollab/topics.test.ts`

**Why:** cccollab MCP server's `transport/remote.ts` passes `{ channel: <string>, includeArchived }` to listByChannel. Phase 1 implementation accepts `{ channelId: v.id(...) }`. We can either change KAI's signature or adapt the MCP server. This task does the former — accepts both `channelId` AND `channel` (name) so the MCP server's existing call works unchanged.

- [ ] **Step 1: Write failing tests**

Append to `frontend/src/convex/cccollab/topics.test.ts`:

```typescript
describe('cccollab.topics.listByChannel (by name)', () => {
  test('lists topics when called with channel name instead of id', async () => {
    const t = convexTest(schema, modules)
    const { as, sessionId } = await setupAndJoinChannel(t, 'u1', 'alice', 'dev')
    await as.mutation(api.cccollab.topics.start, {
      sessionId,
      channel: 'dev',
      topic: 'plan',
    })

    const topics = await as.query(api.cccollab.topics.listByChannel, {
      channel: 'dev',
    })
    expect(topics).toHaveLength(1)
    expect(topics[0].topic).toBe('plan')
  })

  test('returns topic shape with topicId alias when MCP server expects it', async () => {
    const t = convexTest(schema, modules)
    const { as, sessionId } = await setupAndJoinChannel(t, 'u1', 'alice', 'dev')
    const { topicId } = await as.mutation(api.cccollab.topics.start, {
      sessionId,
      channel: 'dev',
      topic: 'plan',
    })

    const topics = await as.query(api.cccollab.topics.listByChannel, {
      channel: 'dev',
    })
    // Each row should carry _id (Convex idiom) AND topicId (MCP server idiom).
    // The MCP server reads `topicId` per the remote transport call site.
    expect(topics[0]._id).toBe(topicId)
    expect(topics[0].topicId).toBe(topicId)
  })

  test('throws CHANNEL_NOT_FOUND when channel name does not exist', async () => {
    const t = convexTest(schema, modules)
    await setupAndJoinChannel(t, 'u1', 'alice', 'dev')
    const as = t.withIdentity({ subject: 'u1' })
    await expect(
      as.query(api.cccollab.topics.listByChannel, { channel: 'does-not-exist' })
    ).rejects.toThrow(/CHANNEL_NOT_FOUND/)
  })
})
```

The existing channelId-based tests stay; this adds a parallel channel-name path.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement dual signature**

Update `frontend/src/convex/cccollab/topics.ts` `listByChannel` to accept EITHER `channelId` or `channel`:

```typescript
export const listByChannel = query({
  args: {
    channelId: v.optional(v.id('cccollabChannels')),
    channel: v.optional(v.string()),
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await convexAuth(ctx)

    let channelId: Id<'cccollabChannels'>
    if (args.channelId) {
      channelId = args.channelId
    } else if (args.channel) {
      const normalized = requireNormalizedChannelName(args.channel)
      const channel = await ctx.db
        .query('cccollabChannels')
        .withIndex('by_normalizedName', (q) => q.eq('normalizedName', normalized))
        .unique()
      if (!channel) {
        throw new ConvexError({
          code: 'CHANNEL_NOT_FOUND',
          message: `No channel "${args.channel}".`,
        })
      }
      channelId = channel._id
    } else {
      throw new ConvexError({
        code: 'CHANNEL_REQUIRED',
        message: 'Pass either channelId or channel (name).',
      })
    }

    await assertCallerSubscribedToChannel(ctx, user._id, channelId)
    const all = await ctx.db
      .query('cccollabTopics')
      .withIndex('by_channel', (q) => q.eq('channelId', channelId))
      .collect()
    const filtered = args.includeArchived ? all : all.filter((t) => t.state === 'active')
    return filtered.map((t) => ({
      _id: t._id,
      topicId: t._id, // alias for MCP server compatibility
      topic: t.topic,
      state: t.state,
      creatorSessionId: t.creatorSessionId,
      createdAt: t.createdAt,
    }))
  },
})
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn test --run
```

Expected: 209 total (206 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/convex/cccollab/topics.ts frontend/src/convex/cccollab/topics.test.ts
git commit -m "$(cat <<'EOF'
feat(cccollab): listByChannel accepts channel name + topicId alias

Adds optional `channel: string` arg alongside `channelId: v.id(...)`
and returns `topicId` aliasing `_id` so MCP server's existing call
shape works against KAI's Convex.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task A5: messages.listByChannel — server-side cursor consultation

**Files:**
- Modify: `frontend/src/convex/cccollab/messages.ts`
- Modify: `frontend/src/convex/cccollab/messages.test.ts`

**Why:** cccollab MCP server's restart-replay suppression depends on the backend consulting the per-session read cursor automatically. The MCP server passes `sessionId` to listByChannel; the function looks up the user's cursor in `cccollabChannelReadCursors` and filters to `ts > lastDeliveredTs`. Without this, the MCP server replays the channel backlog on every restart.

- [ ] **Step 1: Write failing test**

```typescript
describe('cccollab.messages.listByChannel (cursor consultation)', () => {
  test('filters by stored cursor when sessionId is supplied', async () => {
    const t = convexTest(schema, modules)
    const { as, sessionId, channelId } = await setupTopic(t, 'u1', 'alice', 'dev', 'plan')

    const r1 = await as.mutation(api.cccollab.messages.sendToChannel, {
      sessionId,
      channel: 'dev',
      text: 'm1',
    })
    const r2 = await as.mutation(api.cccollab.messages.sendToChannel, {
      sessionId,
      channel: 'dev',
      text: 'm2',
    })

    // Ack the first message
    await as.mutation(api.cccollab.messages.ackChannel, {
      sessionId,
      channelId,
      ts: r1.ts,
    })

    // Now listByChannel with sessionId should consult the cursor and return
    // only r2 (everything > r1.ts)
    const fromCursor = await as.query(api.cccollab.messages.listByChannel, {
      channelId,
      sessionId,
    })
    expect(fromCursor).toHaveLength(1)
    expect(fromCursor[0].text).toBe('m2')

    // Explicit sinceTs still overrides cursor
    const explicit = await as.query(api.cccollab.messages.listByChannel, {
      channelId,
      sinceTs: 0,
    })
    expect(explicit).toHaveLength(2)
  })

  test('returns full feed when sessionId supplied but no cursor exists', async () => {
    const t = convexTest(schema, modules)
    const { as, sessionId, channelId } = await setupTopic(t, 'u1', 'alice', 'dev', 'plan')
    await as.mutation(api.cccollab.messages.sendToChannel, {
      sessionId,
      channel: 'dev',
      text: 'm1',
    })
    const messages = await as.query(api.cccollab.messages.listByChannel, {
      channelId,
      sessionId,
    })
    expect(messages).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement cursor consultation**

```typescript
export const listByChannel = query({
  args: {
    channelId: v.id('cccollabChannels'),
    sinceTs: v.optional(v.number()),
    sessionId: v.optional(v.id('cccollabSessions')),
  },
  handler: async (ctx, args) => {
    const user = await convexAuth(ctx)
    await assertCallerSubscribedToChannel(ctx, user._id, args.channelId)

    // Resolve effective cursor:
    //   1. Explicit sinceTs overrides everything
    //   2. Otherwise, if sessionId supplied, consult stored cursor
    //   3. Otherwise, no cursor (sinceTs = 0)
    let effectiveTs = args.sinceTs ?? 0
    if (args.sinceTs === undefined && args.sessionId !== undefined) {
      const session = await ctx.db.get(args.sessionId)
      if (session && session.userId === user._id) {
        const cursor = await ctx.db
          .query('cccollabChannelReadCursors')
          .withIndex('by_user_and_sessionName_and_channel', (q) =>
            q
              .eq('userId', user._id)
              .eq('sessionName', session.sessionName)
              .eq('channelId', args.channelId)
          )
          .unique()
        if (cursor) effectiveTs = cursor.lastDeliveredTs
      }
    }

    const messages = await ctx.db
      .query('cccollabMessages')
      .withIndex('by_channel_and_ts', (q) =>
        q.eq('channelId', args.channelId).gte('ts', effectiveTs)
      )
      .filter((q) => q.eq(q.field('kind'), 'broadcast'))
      .order('asc')
      .collect()

    return messages.map((m) => ({
      _id: m._id,
      kind: m.kind,
      fromSessionId: m.fromSessionId,
      fromUserId: m.fromUserId,
      senderName: m.senderName,
      senderAvatarUrl: m.senderAvatarUrl,
      text: m.text,
      ts: m.ts,
    }))
  },
})
```

Note `.gte` not `.gt` — Phase 1 fix #4 set this to inclusive; client dedupes by `_id`.

- [ ] **Step 4: Run — expect PASS**

```bash
yarn test --run
```

Expected: 211 total (209 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/convex/cccollab/messages.ts frontend/src/convex/cccollab/messages.test.ts
git commit -m "$(cat <<'EOF'
feat(cccollab): listByChannel consults read cursor when sessionId supplied

MCP server's restart-replay suppression relies on the server filtering
to ts >= cursor.lastDeliveredTs. When listByChannel is called with
sessionId, look up the per-(user, sessionName, channel) cursor and
seed the range scan from it. Explicit sinceTs still overrides.

Also includes denormalized senderName/senderAvatarUrl in the returned
shape (per Task A1/A2).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task A6: Monotonic ts for DMs

**Files:**
- Modify: `frontend/src/convex/cccollab/helpers.ts`
- Modify: `frontend/src/convex/cccollab/messages.ts`
- Modify: `frontend/src/convex/cccollab/messages.test.ts`

**Why:** Phase 1's `sendToSession` uses raw `Date.now()` for `ts`. Two DMs to the same recipient in the same millisecond collide. Need `allocateRecipientTs(toSessionId)` analogous to `allocateChannelTs(channelId)`.

- [ ] **Step 1: Add helper to helpers.ts**

```typescript
/**
 * Monotonic per-recipient timestamp allocator for DMs.
 * Mirrors allocateChannelTs but uses `by_toSessionId_and_ts`.
 */
export async function allocateRecipientTs(
  ctx: MutationCtx,
  toSessionId: Id<'cccollabSessions'>
): Promise<number> {
  const latest = await ctx.db
    .query('cccollabMessages')
    .withIndex('by_toSessionId_and_ts', (q) => q.eq('toSessionId', toSessionId))
    .order('desc')
    .first()
  const now = Date.now()
  if (!latest) return now
  return Math.max(now, latest.ts + 1)
}
```

- [ ] **Step 2: Write failing test**

```typescript
describe('cccollab.messages.sendToSession (monotonic ts)', () => {
  test('allocates strictly monotonic ts in a burst to same recipient', async () => {
    const t = convexTest(schema, modules)
    const { as: asAlice, sessionId: aliceSession } = await setupTopic(t, 'u1', 'alice', 'dev', 'plan')
    await t.run(async (ctx) => {
      await ctx.db.insert('users', { clerkId: 'u2', email: 'u2@example.com', name: 'u2' })
    })
    const asBob = t.withIdentity({ subject: 'u2' })
    const { sessionId: bobSession } = await asBob.mutation(api.cccollab.sessions.introduce, {
      sessionName: 'bob',
    })
    await asBob.mutation(api.cccollab.channels.join, { sessionId: bobSession, channel: 'dev' })

    const tss: number[] = []
    for (let i = 0; i < 5; i++) {
      const result = await asAlice.mutation(api.cccollab.messages.sendToSession, {
        sessionId: aliceSession,
        toSessionId: bobSession,
        text: `dm ${i}`,
      })
      tss.push(result.ts)
    }
    for (let i = 1; i < tss.length; i++) {
      expect(tss[i]).toBeGreaterThan(tss[i - 1])
    }
  })
})
```

- [ ] **Step 3: Run — expect FAIL** (intermittent — passes if timer rolls between calls)

- [ ] **Step 4: Wire allocateRecipientTs into sendToSession**

In `frontend/src/convex/cccollab/messages.ts` `sendToSession` handler, replace `const ts = Date.now()` with:

```typescript
const ts = await allocateRecipientTs(ctx, recipientId)
```

Update the import at top of file:

```typescript
import { allocateChannelTs, allocateRecipientTs, requireNormalizedChannelName, requireTopic } from './helpers'
```

- [ ] **Step 5: Run — expect PASS**

```bash
yarn test --run
```

Expected: 212 total (211 + 1 new).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/convex/cccollab/helpers.ts frontend/src/convex/cccollab/messages.ts frontend/src/convex/cccollab/messages.test.ts
git commit -m "$(cat <<'EOF'
feat(cccollab): monotonic per-recipient ts for DMs

allocateRecipientTs mirrors allocateChannelTs but uses
by_toSessionId_and_ts. Eliminates millisecond collisions when sending
DMs in tight bursts to the same recipient.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task A7: ESLint rule preventing bare ConvexError(string)

**Files:**
- Modify: `frontend/eslint.config.mjs` (verify the actual eslint config file in KAI)
- Possibly create: `frontend/.eslint-plugin-cccollab/no-bare-convex-error-string.js` (or inline as a config rule)

**Why:** Phase 1 fix #1 converted all bare `ConvexError(string)` to structured `ConvexError({ code, message })`. Without a lint rule, regressions slip in. The MCP server's `extractConvexErrorCode` depends on `err.data.code` being a string field — bare strings break it silently.

This task uses ESLint's `no-restricted-syntax` rule (no plugin needed):

- [ ] **Step 1: Read current ESLint config**

```bash
cat /Users/sandhu/Documents/Projects/kollaborativeai/frontend/eslint.config.mjs
```

- [ ] **Step 2: Add scoped no-restricted-syntax rule**

Add an override block scoped to `src/convex/cccollab/**/*.ts`:

```javascript
// in frontend/eslint.config.mjs, alongside existing config blocks
{
  files: ['src/convex/cccollab/**/*.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "NewExpression[callee.name='ConvexError'] > Literal:first-child",
        message:
          'Use structured ConvexError({ code, message }) — bare strings break MCP error routing.',
      },
      {
        selector: "NewExpression[callee.name='ConvexError'] > TemplateLiteral:first-child",
        message:
          'Use structured ConvexError({ code, message }) — bare strings break MCP error routing.',
      },
    ],
  },
},
```

- [ ] **Step 3: Verify lint catches a violation**

Temporarily add a violating line to `frontend/src/convex/cccollab/helpers.ts`:

```typescript
// TEMPORARY — must be deleted before commit
function _violation() { throw new ConvexError('BARE_STRING') }
```

Run:

```bash
cd /Users/sandhu/Documents/Projects/kollaborativeai/frontend
yarn lint:check 2>&1 | grep -i 'restricted-syntax\|BARE_STRING'
```

Expected: lint error reporting the violation.

Delete the temporary line:

```typescript
// Restore helpers.ts to its pre-Step-3 state
```

- [ ] **Step 4: Final lint — expect clean**

```bash
yarn lint:check
```

Expected: no errors (Phase 1's structured errors all pass; no violations remain).

- [ ] **Step 5: Commit**

```bash
git add frontend/eslint.config.mjs
git commit -m "$(cat <<'EOF'
chore(cccollab): lint rule against bare ConvexError(string)

Scoped to src/convex/cccollab/**. Bare-string ConvexError breaks
MCP server's err.data.code extraction — Phase 1 fix #1 converted
existing offenders to structured form. This rule prevents regression.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task A8: Tests for DM_RECIPIENT_AMBIGUOUS and DM_TARGET_REQUIRED

**Files:**
- Modify: `frontend/src/convex/cccollab/messages.test.ts`

**Why:** Phase 1 implemented these error paths in `sendToSession` (the name-based DM branch) but the happy-path tests covered only the explicit-id branch. The error branches are unverified.

- [ ] **Step 1: Add the two tests**

Append to the existing `describe('cccollab.messages.sendToSession', ...)` block:

```typescript
  test('throws DM_TARGET_REQUIRED when neither toSessionId nor toSessionName supplied', async () => {
    const t = convexTest(schema, modules)
    const { as, sessionId } = await setupTopic(t, 'u1', 'alice', 'dev', 'plan')

    await expect(
      as.mutation(api.cccollab.messages.sendToSession, {
        sessionId,
        text: 'who?',
      })
    ).rejects.toThrow(/DM_TARGET_REQUIRED/)
  })

  test('throws DM_RECIPIENT_AMBIGUOUS when name resolves to multiple sessions in same channel', async () => {
    const t = convexTest(schema, modules)
    // Alice + two Bobs (separate KAI users) both with sessionName "bob",
    // both joined to dev channel
    const { as: asAlice, sessionId: aliceSession } = await setupTopic(t, 'u1', 'alice', 'dev', 'plan')

    for (const clerkId of ['u2', 'u3']) {
      await t.run(async (ctx) => {
        await ctx.db.insert('users', {
          clerkId,
          email: `${clerkId}@example.com`,
          name: clerkId,
        })
      })
      const as = t.withIdentity({ subject: clerkId })
      const { sessionId } = await as.mutation(api.cccollab.sessions.introduce, {
        sessionName: 'bob',
      })
      await as.mutation(api.cccollab.channels.join, { sessionId, channel: 'dev' })
    }

    await expect(
      asAlice.mutation(api.cccollab.messages.sendToSession, {
        sessionId: aliceSession,
        toSessionName: 'bob',
        text: 'which bob?',
      })
    ).rejects.toThrow(/DM_RECIPIENT_AMBIGUOUS/)
  })
```

- [ ] **Step 2: Run — expect PASS** (these test existing behavior; should pass immediately)

```bash
yarn test --run
```

Expected: 214 total (212 + 2 new).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/convex/cccollab/messages.test.ts
git commit -m "$(cat <<'EOF'
test(cccollab): cover DM_RECIPIENT_AMBIGUOUS and DM_TARGET_REQUIRED

Phase 1 implemented these error branches in sendToSession but the
happy-path tests only exercised the explicit-id path. Locks in
the contract for the name-based branch.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task A9: Part A final verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite + lint + format + build**

```bash
cd /Users/sandhu/Documents/Projects/kollaborativeai/frontend
yarn test --run
yarn tsc --noEmit
yarn lint:check
yarn build
cd ..
yarn format:check
```

Expected: 214/214 tests; typecheck clean; lint clean; build success; format clean.

- [ ] **Step 2: Push the branch**

```bash
cd /path/to/kai-worktree
git push -u origin feat/cccollab-phase2a-wire-compat
```

- [ ] **Step 3: Open PR** (or local merge per project convention — ask user)

---

# PART B — cccollab MCP Server Clerk Auth

Working directory: a worktree on the cccollab repo at `/Users/sandhu/Documents/Projects/cccollab/`.

**Branch suggestion:** `feat/clerk-auth`

## Task B0: Clerk Dashboard setup (one-time human action)

**Files:**
- Create: `mcp_server/docs/architecture/clerk-auth-setup.md` (or `docs/architecture/clerk-auth-setup.md` per repo convention)

This is a checklist for the operator running the integration the first time. No code changes; just documentation.

- [ ] **Step 1: Create the doc**

```markdown
# Clerk OAuth Setup for cccollab CLI

Required for the `clerk` auth path against KAI's Convex deployment.
One-time setup per Clerk environment (dev / prod).

## In Clerk Dashboard

1. Navigate to **Configure → OAuth Applications**.
2. Click **Add OAuth application**:
   - **Name:** `cccollab-cli`
   - **Client type:** Public (no client secret)
   - **Require PKCE:** Yes (S256)
   - **Authorized redirect URLs:** `http://127.0.0.1:*/cccollab-oauth-callback`
   - **Scopes:** `openid profile email`
3. Note the **Issuer URL** (e.g. `https://your-instance.clerk.accounts.dev` or `https://clerk.your-domain.com`).
4. Note the **Client ID** (will be the literal `cccollab-cli` or a generated id — copy whatever Clerk produces).

## In Clerk JWT Templates

Verify the `convex` template exists. KAI already uses it for the web app — same template works for the CLI.

If you need to add it: template name `convex`, audience `convex`, lifetime ≤ 60s.

## Per-user config

End users put this in `~/.cccollab/config.json`:

\`\`\`json
{
  "locations": {
    "kai": {
      "url": "https://<kai-deployment>.convex.cloud",
      "authType": "clerk",
      "clerkIssuer": "https://<clerk-instance>.clerk.accounts.dev",
      "clerkClientId": "cccollab-cli"
    }
  }
}
\`\`\`

After running `authenticate --location kai`, tokens are appended:

\`\`\`json
{
  "kai": {
    "url": "...",
    "authType": "clerk",
    "clerkIssuer": "...",
    "clerkClientId": "cccollab-cli",
    "refreshToken": "<rt>",
    "accessToken": "<short-lived jwt>",
    "accessTokenExpiresAt": 1715000000000
  }
}
\`\`\`

File mode is 0600 (existing cccollab convention).
```

- [ ] **Step 2: Commit**

```bash
cd /path/to/cccollab-worktree
git add docs/architecture/clerk-auth-setup.md  # adjust path per repo layout
git commit -m "docs(clerk-auth): add Clerk Dashboard setup checklist"
```

---

## Task B1: Config schema — discriminated-union authType

**Files:**
- Modify: `mcp_server/src/config/schema.ts`
- Possibly create: `mcp_server/src/config/schema.test.ts` (verify if exists)

**Why:** Each location currently allows any combination of auth fields. Phase 2 needs a strict discrimination so the rest of the code knows which auth code path applies.

- [ ] **Step 1: Read existing schema.ts**

Find `LocationConfigSchema`. It currently accepts `url`, `active`, `accessToken`, `refreshToken`, `userEmail`, `userId`, `updatedAt` plus the `channels` map. We'll add `authType`, `clerkIssuer`, `clerkClientId`, `accessTokenExpiresAt` and require them in the right combinations.

- [ ] **Step 2: Define the discriminated schemas**

Replace `LocationConfigSchema` with a discriminated union:

```typescript
const BaseLocationFields = {
  url: z.string().optional(),
  active: z.boolean().optional(),
  userEmail: z.string().optional(),
  userId: z.string().optional(),
  updatedAt: z.number().optional(),
  channels: z.record(z.string(), ChannelConfigSchema).optional(),
}

// Existing Convex Auth flow (Google OAuth → Convex Auth tokens)
const ConvexGoogleLocationSchema = z
  .object({
    ...BaseLocationFields,
    authType: z.literal('convex-google').optional(), // optional for back-compat
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
  })
  .strict()

// New Clerk PKCE flow
const ClerkLocationSchema = z
  .object({
    ...BaseLocationFields,
    authType: z.literal('clerk'),
    clerkIssuer: z.string(),
    clerkClientId: z.string(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    accessTokenExpiresAt: z.number().optional(),
  })
  .strict()

export const LocationConfigSchema = z.union([
  ClerkLocationSchema,
  ConvexGoogleLocationSchema,
])
```

(`authType` is required to be `'clerk'` to select the clerk branch; absent or `'convex-google'` falls through to the legacy branch — preserves back-compat.)

- [ ] **Step 3: Add tests**

```typescript
// frontend/src/convex/... no, this is cccollab repo. Path:
// mcp_server/src/config/schema.test.ts
import { describe, expect, test } from 'vitest'
import { LocationConfigSchema } from './schema'

describe('LocationConfigSchema discriminated union', () => {
  test('accepts clerk location with required clerk fields', () => {
    const result = LocationConfigSchema.safeParse({
      authType: 'clerk',
      url: 'https://x.convex.cloud',
      clerkIssuer: 'https://x.clerk.accounts.dev',
      clerkClientId: 'cccollab-cli',
    })
    expect(result.success).toBe(true)
  })

  test('rejects clerk location missing clerkIssuer', () => {
    const result = LocationConfigSchema.safeParse({
      authType: 'clerk',
      url: 'https://x.convex.cloud',
      clerkClientId: 'cccollab-cli',
    })
    expect(result.success).toBe(false)
  })

  test('accepts legacy convex-google location with no authType field', () => {
    const result = LocationConfigSchema.safeParse({
      url: 'https://x.convex.cloud',
      accessToken: 'tok',
      refreshToken: 'rt',
    })
    expect(result.success).toBe(true)
  })

  test('accepts convex-google location with explicit authType', () => {
    const result = LocationConfigSchema.safeParse({
      authType: 'convex-google',
      url: 'https://x.convex.cloud',
      accessToken: 'tok',
      refreshToken: 'rt',
    })
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 4: Run + verify other tests still pass**

```bash
cd /path/to/cccollab-worktree/mcp_server
yarn test --run
```

Expected: existing tests pass + 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
cd /path/to/cccollab-worktree
git add mcp_server/src/config/schema.ts mcp_server/src/config/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(config): discriminated-union authType for location config

Adds a 'clerk' authType variant requiring clerkIssuer + clerkClientId
alongside the existing convex-google flow. Both shapes are valid;
'clerk' is selected by literal authType field, otherwise legacy
convex-google applies (preserves back-compat for unmigrated configs).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task B2: Config load + merge — propagate authType

**Files:**
- Modify: `mcp_server/src/config/load.ts` (verify what's there)
- Modify: `mcp_server/src/config/merge.ts`
- Modify: `mcp_server/src/config/save.ts`
- Modify: `mcp_server/src/config/resolve.ts`

**Why:** Schema accepts the new shape (Task B1). Now the load/merge/save pipeline must round-trip it. Specifically, `save.ts` writes auth tokens during `authenticate`; it needs to know which authType is being saved.

- [ ] **Step 1: Read existing config files**

Specifically `save.ts` — find `saveLocationAuth` or similar function that writes the access/refresh tokens. Identify its signature.

- [ ] **Step 2: Extend saveLocationAuth signature**

Update the function to optionally accept Clerk-specific fields. Example:

```typescript
export type SaveAuthArgs =
  | {
      authType: 'convex-google'
      locationName: string
      accessToken: string
      refreshToken: string
      userEmail?: string
      userId?: string
    }
  | {
      authType: 'clerk'
      locationName: string
      accessToken: string
      refreshToken: string
      accessTokenExpiresAt: number
      userEmail?: string
      userId?: string
    }

export async function saveLocationAuth(args: SaveAuthArgs): Promise<void> {
  await withConfigLock(async (persist) => {
    const config = await loadUserConfig()
    const location = config.locations?.[args.locationName] ?? {}

    if (args.authType === 'clerk') {
      location.authType = 'clerk'
      location.accessToken = args.accessToken
      location.refreshToken = args.refreshToken
      location.accessTokenExpiresAt = args.accessTokenExpiresAt
    } else {
      location.accessToken = args.accessToken
      location.refreshToken = args.refreshToken
    }

    if (args.userEmail) location.userEmail = args.userEmail
    if (args.userId) location.userId = args.userId
    location.updatedAt = Date.now()

    config.locations = config.locations ?? {}
    config.locations[args.locationName] = location
    await persist(config)
  })
}
```

(Pseudo-shape — adapt to actual existing function.)

- [ ] **Step 3: Update merge.ts credential-stripping**

The existing merge code strips auth fields from project-level configs. Extend to also strip `accessTokenExpiresAt` (it's an auth field) and `authType` (no — keep authType, it's a configuration choice, not a credential). Verify the credential warning still fires.

- [ ] **Step 4: Tests**

Add tests in `mcp_server/src/config/save.test.ts` (or wherever save's tests live) covering:
- Save authType=clerk writes the right fields
- Save authType=convex-google preserves legacy behavior
- Reading back after save produces a schema-valid LocationConfig

- [ ] **Step 5: Run tests + typecheck**

```bash
cd /path/to/cccollab-worktree/mcp_server
yarn test --run
yarn typecheck
```

- [ ] **Step 6: Commit**

```bash
git add mcp_server/src/config/
git commit -m "$(cat <<'EOF'
feat(config): saveLocationAuth handles authType='clerk' fields

Extends the existing save path to persist accessTokenExpiresAt and
preserve the authType marker on the location. Convex-google path
unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task B3: PKCE primitives

**Files:**
- Create: `mcp_server/src/remote/auth-clerk.ts`
- Create: `mcp_server/src/remote/auth-clerk.test.ts`

**Why:** OAuth 2.0 PKCE requires a code verifier (random 43-128 chars) and an S256 code challenge (base64url(SHA256(verifier))). These are small, testable in isolation.

- [ ] **Step 1: Failing tests**

```typescript
// mcp_server/src/remote/auth-clerk.test.ts
import { describe, expect, test } from 'vitest'
import { createHash } from 'crypto'
import { generateCodeVerifier, deriveCodeChallenge } from './auth-clerk'

describe('PKCE primitives', () => {
  test('generateCodeVerifier produces 43-128 char base64url string', () => {
    const v = generateCodeVerifier()
    expect(v.length).toBeGreaterThanOrEqual(43)
    expect(v.length).toBeLessThanOrEqual(128)
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('generateCodeVerifier produces unique values', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()))
    expect(set.size).toBe(50)
  })

  test('deriveCodeChallenge is base64url(SHA256(verifier))', () => {
    const verifier = 'test_verifier_abcdef0123456789-_~ABCDEFGHIJK'
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(deriveCodeChallenge(verifier)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /path/to/cccollab-worktree/mcp_server
yarn test src/remote/auth-clerk.test.ts --run
```

- [ ] **Step 3: Implement**

```typescript
// mcp_server/src/remote/auth-clerk.ts
import { createHash, randomBytes } from 'crypto'

/**
 * Generate a cryptographically-random PKCE code verifier per RFC 7636 §4.1.
 * 64 bytes of randomness → 86-char base64url string (well within the 43-128
 * char limit).
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(64))
}

/**
 * Derive the S256 code challenge for a given verifier (RFC 7636 §4.2).
 */
export function deriveCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest())
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
yarn test src/remote/auth-clerk.test.ts --run
```

- [ ] **Step 5: Commit**

```bash
git add mcp_server/src/remote/auth-clerk.ts mcp_server/src/remote/auth-clerk.test.ts
git commit -m "$(cat <<'EOF'
feat(clerk-auth): PKCE primitives (verifier + S256 challenge)

generateCodeVerifier: 64 bytes of randomBytes → 86-char base64url.
deriveCodeChallenge: base64url(SHA256(verifier)).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task B4: Clerk authorize URL + token exchange

**Files:**
- Modify: `mcp_server/src/remote/auth-clerk.ts`
- Modify: `mcp_server/src/remote/auth-clerk.test.ts`

- [ ] **Step 1: Failing tests**

Append to `auth-clerk.test.ts`:

```typescript
describe('buildAuthorizeUrl', () => {
  test('produces a Clerk-compatible OAuth authorize URL', () => {
    const url = buildAuthorizeUrl({
      issuer: 'https://x.clerk.accounts.dev',
      clientId: 'cccollab-cli',
      redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
      codeChallenge: 'abc123',
      state: 'state-xyz',
    })
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://x.clerk.accounts.dev/oauth/authorize')
    expect(u.searchParams.get('client_id')).toBe('cccollab-cli')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:12345/cccollab-oauth-callback')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('code_challenge')).toBe('abc123')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('state')).toBe('state-xyz')
    expect(u.searchParams.get('scope')).toBe('openid profile email')
  })
})

describe('exchangeCodeForTokens', () => {
  test('POSTs the right form to /oauth/token and returns parsed tokens', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = []
    const fetchMock = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: init.body as string,
        headers: init.headers as Record<string, string>,
      })
      return new Response(
        JSON.stringify({
          access_token: 'at_123',
          refresh_token: 'rt_456',
          expires_in: 60,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch

    const result = await exchangeCodeForTokens(
      {
        issuer: 'https://x.clerk.accounts.dev',
        clientId: 'cccollab-cli',
        redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
        code: 'code-abc',
        codeVerifier: 'verifier-xyz',
      },
      fetchMock
    )

    expect(result.accessToken).toBe('at_123')
    expect(result.refreshToken).toBe('rt_456')
    expect(result.accessTokenExpiresAt).toBeGreaterThan(Date.now())
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://x.clerk.accounts.dev/oauth/token')
    const body = new URLSearchParams(calls[0].body)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code-abc')
    expect(body.get('code_verifier')).toBe('verifier-xyz')
    expect(body.get('client_id')).toBe('cccollab-cli')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:12345/cccollab-oauth-callback')
  })

  test('throws on non-200 token response', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch
    await expect(
      exchangeCodeForTokens(
        {
          issuer: 'https://x.clerk.accounts.dev',
          clientId: 'cccollab-cli',
          redirectUri: 'http://127.0.0.1:12345/cccollab-oauth-callback',
          code: 'bad',
          codeVerifier: 'v',
        },
        fetchMock
      )
    ).rejects.toThrow(/invalid_grant/)
  })
})
```

Update the import at the top:

```typescript
import { generateCodeVerifier, deriveCodeChallenge, buildAuthorizeUrl, exchangeCodeForTokens } from './auth-clerk'
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Append to `auth-clerk.ts`:

```typescript
export interface AuthorizeUrlArgs {
  issuer: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  scopes?: string[]
}

export function buildAuthorizeUrl(args: AuthorizeUrlArgs): string {
  const url = new URL('/oauth/authorize', args.issuer)
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', args.state)
  url.searchParams.set('scope', (args.scopes ?? ['openid', 'profile', 'email']).join(' '))
  return url.toString()
}

export interface TokenExchangeArgs {
  issuer: string
  clientId: string
  redirectUri: string
  code: string
  codeVerifier: string
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: number
}

export async function exchangeCodeForTokens(
  args: TokenExchangeArgs,
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  const url = new URL('/oauth/token', args.issuer).toString()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
  })
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const errorCode = typeof json.error === 'string' ? json.error : 'token_exchange_failed'
    throw new Error(`Clerk token exchange failed: ${errorCode}`)
  }
  const accessToken = json.access_token
  const refreshToken = json.refresh_token
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Unexpected token response shape: ${JSON.stringify(json)}`)
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
  }
}

export async function refreshAccessToken(
  args: { issuer: string; clientId: string; refreshToken: string },
  fetchImpl: typeof fetch = fetch
): Promise<TokenSet> {
  const url = new URL('/oauth/token', args.issuer).toString()
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  })
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const errorCode = typeof json.error === 'string' ? json.error : 'refresh_failed'
    throw new Error(`Clerk refresh failed: ${errorCode}`)
  }
  const accessToken = json.access_token
  const refreshToken = json.refresh_token ?? args.refreshToken
  const expiresIn = json.expires_in
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresIn !== 'number') {
    throw new Error(`Unexpected refresh response shape: ${JSON.stringify(json)}`)
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
  }
}
```

- [ ] **Step 4: Add refresh tests**

```typescript
describe('refreshAccessToken', () => {
  test('exchanges refresh token for new tokens', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'new_at',
          refresh_token: 'new_rt',
          expires_in: 60,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch

    const result = await refreshAccessToken(
      { issuer: 'https://x.clerk.accounts.dev', clientId: 'cccollab-cli', refreshToken: 'old_rt' },
      fetchMock
    )
    expect(result.accessToken).toBe('new_at')
    expect(result.refreshToken).toBe('new_rt')
  })

  test('preserves prior refresh token if server omits one', async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ access_token: 'new_at', expires_in: 60 }), {
        status: 200,
      })) as typeof fetch

    const result = await refreshAccessToken(
      { issuer: 'https://x.clerk.accounts.dev', clientId: 'cccollab-cli', refreshToken: 'old_rt' },
      fetchMock
    )
    expect(result.refreshToken).toBe('old_rt')
  })
})
```

Update import to include `refreshAccessToken`.

- [ ] **Step 5: Run — expect PASS**

```bash
yarn test src/remote/auth-clerk.test.ts --run
```

- [ ] **Step 6: Commit**

```bash
git add mcp_server/src/remote/auth-clerk.ts mcp_server/src/remote/auth-clerk.test.ts
git commit -m "$(cat <<'EOF'
feat(clerk-auth): authorize URL + token exchange + refresh

buildAuthorizeUrl: constructs Clerk's /oauth/authorize URL with PKCE.
exchangeCodeForTokens: POSTs /oauth/token with grant_type=authorization_code.
refreshAccessToken: POSTs /oauth/token with grant_type=refresh_token,
preserving prior refresh token when Clerk omits one in the response.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task B5: runClerkPkce orchestration

**Files:**
- Modify: `mcp_server/src/remote/auth-clerk.ts`
- Modify: `mcp_server/src/remote/auth-clerk.test.ts`

**Why:** Orchestrate the full flow — start loopback listener, generate verifier+challenge, open browser, wait for callback, exchange code, return TokenSet + identity. Reuses existing `startLoopbackListener` and `openBrowser` from `mcp_server/src/remote/{auth.ts,browser.ts}`.

- [ ] **Step 1: Read existing loopback + browser helpers**

The existing flow in `mcp_server/src/remote/auth.ts:181` spins up a 127.0.0.1 server, opens browser, waits for `?code=…&state=…` redirect. Identify the exported helper (likely `startLoopbackListener` or similar) and its return shape.

- [ ] **Step 2: Define runClerkPkce**

Append to `auth-clerk.ts`:

```typescript
import { startLoopbackListener } from './auth'  // reuse — verify exported
import { openBrowser } from './browser'

export interface RunClerkPkceArgs {
  issuer: string
  clientId: string
  scopes?: string[]
  timeoutMs?: number
  onAuthorizeUrl?: (url: string) => void  // hook for tests
}

export async function runClerkPkce(args: RunClerkPkceArgs): Promise<TokenSet> {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = deriveCodeChallenge(codeVerifier)
  const state = generateCodeVerifier().slice(0, 32) // random state

  const listener = await startLoopbackListener({
    path: '/cccollab-oauth-callback',
    timeoutMs: args.timeoutMs ?? 5 * 60 * 1000,
  })

  const redirectUri = `http://127.0.0.1:${listener.port}/cccollab-oauth-callback`
  const authorizeUrl = buildAuthorizeUrl({
    issuer: args.issuer,
    clientId: args.clientId,
    redirectUri,
    codeChallenge,
    state,
    scopes: args.scopes,
  })

  if (args.onAuthorizeUrl) args.onAuthorizeUrl(authorizeUrl)
  else await openBrowser(authorizeUrl)

  const callback = await listener.waitForCallback()
  if (callback.state !== state) {
    throw new Error(`OAuth state mismatch: expected ${state}, got ${callback.state}`)
  }
  if (!callback.code) {
    throw new Error('OAuth callback missing code')
  }

  return await exchangeCodeForTokens({
    issuer: args.issuer,
    clientId: args.clientId,
    redirectUri,
    code: callback.code,
    codeVerifier,
  })
}
```

(`startLoopbackListener` shape and `openBrowser` API: adapt to what's actually exported. The plan assumes these are already factored — Task B0 / cccollab's existing code provides them. If they aren't extractable as drop-in helpers, refactor first as a precursor task and split out.)

- [ ] **Step 3: Tests with mock loopback**

```typescript
describe('runClerkPkce orchestration', () => {
  test('full flow yields a TokenSet', async () => {
    // This is a higher-level integration-ish test. It requires either
    // mocking startLoopbackListener and openBrowser, or running with a
    // real listener and mocking fetch. Choose whichever fits cccollab's
    // existing test patterns — there's almost certainly precedent in
    // `mcp_server/src/remote/auth.test.ts`.
    //
    // Pseudocode:
    //   - Mock startLoopbackListener to return { port: 12345, waitForCallback: () => Promise.resolve({code:'c', state}) }
    //   - Capture authorizeUrl via onAuthorizeUrl hook
    //   - Mock fetch on /oauth/token to return tokens
    //   - Assert TokenSet returned
  })
})
```

(Detailed test left to the implementer who can see cccollab's existing test patterns — placeholder OK because the primitives are well-tested in B3/B4.)

- [ ] **Step 4: Commit**

```bash
git add mcp_server/src/remote/auth-clerk.ts mcp_server/src/remote/auth-clerk.test.ts
git commit -m "$(cat <<'EOF'
feat(clerk-auth): runClerkPkce orchestration

Combines loopback listener + browser open + verifier/challenge gen +
state check + code exchange into a single end-to-end runClerkPkce()
helper. Reuses startLoopbackListener and openBrowser from the
existing convex-google auth flow.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task B6: authenticate tool branches on authType

**Files:**
- Modify: `mcp_server/src/tools/identity.ts`

**Why:** The `authenticate` MCP tool is the user-facing entry point. Today it calls the Convex-Auth-based `runAuthenticate`. We add a branch: when the target location's `authType === 'clerk'`, call `runClerkPkce` instead.

- [ ] **Step 1: Read existing authenticate tool**

Find the handler. Identify where it resolves the location config and calls the auth flow.

- [ ] **Step 2: Add the clerk branch**

```typescript
import { runClerkPkce } from '../remote/auth-clerk'
import { saveLocationAuth } from '../config/save'

// Inside the authenticate handler, after resolving `location` (the LocationConfig):
if (location.authType === 'clerk') {
  if (!location.clerkIssuer || !location.clerkClientId) {
    return jsonError('clerk authentication requires clerkIssuer and clerkClientId on the location config')
  }
  const tokens = await runClerkPkce({
    issuer: location.clerkIssuer,
    clientId: location.clerkClientId,
  })
  await saveLocationAuth({
    authType: 'clerk',
    locationName: targetLocation,
    ...tokens,
  })
  // Optional: post-auth smoke call to KAI's whoami to verify the JWT works
  // (mirrors the existing convex-google flow's smoke verification at auth.ts:152)
  return jsonOk({ location: targetLocation, authType: 'clerk' })
}

// ...existing convex-google flow continues below
```

- [ ] **Step 3: Tests**

The authenticate tool likely has existing tests. Add a parallel test for the clerk branch — mock `runClerkPkce` to return a fake TokenSet, verify `saveLocationAuth` is called with the right args.

- [ ] **Step 4: Run + verify**

```bash
cd /path/to/cccollab-worktree/mcp_server
yarn test --run
yarn typecheck
```

- [ ] **Step 5: Commit**

```bash
git add mcp_server/src/tools/identity.ts mcp_server/src/tools/identity.test.ts
git commit -m "$(cat <<'EOF'
feat(authenticate): branch on authType

When the target location has authType=clerk, run the new PKCE flow
via runClerkPkce. Convex-google authentication continues to work
for locations without authType (or authType=convex-google).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task B7: Transport setAuth callback for token refresh

**Files:**
- Modify: `mcp_server/src/transport/remote.ts`
- Modify: `mcp_server/src/remote/client.ts` (the ConvexClient factory)

**Why:** Clerk JWTs (from the `convex` template) live ~60s. The ConvexClient's `setAuth` accepts a callback `(opts: { forceRefreshToken: boolean }) => Promise<string | null>` which the SDK invokes on connect and on auth errors. Pass a callback that reads the stored refresh token, exchanges it via `refreshAccessToken`, persists the new tokens, and returns the access token.

- [ ] **Step 1: Read the existing client.ts**

Identify `createConvexClient` (or whatever the factory is). The existing convex-google path uses the Convex Auth `signIn` action for refresh; the clerk path uses Clerk's `/oauth/token` endpoint.

- [ ] **Step 2: Add clerk-aware refresh path**

Conceptually, the createConvexClient factory branches on `authType`:

```typescript
import { refreshAccessToken } from './auth-clerk'
import { saveLocationAuth, loadLocationAuth, withConfigLock } from '../config/save'

interface CreateConvexClientArgs {
  url: string
  authType: 'clerk' | 'convex-google'
  locationName: string
  // For clerk:
  clerkIssuer?: string
  clerkClientId?: string
}

export async function createConvexClient(args: CreateConvexClientArgs): Promise<ConvexClient> {
  const client = new ConvexClient(args.url)

  if (args.authType === 'clerk') {
    if (!args.clerkIssuer || !args.clerkClientId) {
      throw new Error('clerk client requires clerkIssuer and clerkClientId')
    }
    let refreshInFlight: Promise<string | null> | null = null
    client.setAuth(async ({ forceRefreshToken }) => {
      // Re-read on each callback so concurrent processes that just
      // refreshed are reflected (cross-process safety pattern from
      // existing client.ts convex-google flow).
      const fresh = await withConfigLock(async () => loadLocationAuth(args.locationName))
      const now = Date.now()
      const stillFresh = fresh.accessToken && fresh.accessTokenExpiresAt && fresh.accessTokenExpiresAt - now > 10_000

      if (!forceRefreshToken && stillFresh) return fresh.accessToken!

      if (!fresh.refreshToken) return null
      if (refreshInFlight) return refreshInFlight

      refreshInFlight = (async () => {
        try {
          const fresh2 = await withConfigLock(async () => loadLocationAuth(args.locationName))
          // Did another process refresh while we waited for the lock?
          if (
            fresh2.accessToken &&
            fresh2.accessTokenExpiresAt &&
            fresh2.accessTokenExpiresAt - now > 10_000
          ) {
            return fresh2.accessToken
          }
          const tokens = await refreshAccessToken({
            issuer: args.clerkIssuer!,
            clientId: args.clerkClientId!,
            refreshToken: fresh2.refreshToken!,
          })
          await saveLocationAuth({
            authType: 'clerk',
            locationName: args.locationName,
            ...tokens,
          })
          return tokens.accessToken
        } finally {
          refreshInFlight = null
        }
      })()
      return refreshInFlight
    })
    return client
  }

  // existing convex-google branch — unchanged
  // ...
  return client
}
```

The `loadLocationAuth(name)` helper may or may not exist — extract from existing code or add it.

- [ ] **Step 3: Wire into transport/remote.ts**

`remote.ts` constructs the ConvexClient for a remote location. Update its construction to pass `authType` and clerk fields through.

- [ ] **Step 4: Tests**

Tests for setAuth callback behavior are tricky because they involve concurrency, file I/O, and HTTP. At minimum:
- Test that with a fresh-enough access token, refresh isn't called.
- Test that with an expired token, refresh-via-mocked-fetch is called and the new access token is returned.
- Test that two concurrent calls with `forceRefreshToken=true` share a single refresh (refreshInFlight deduplication).

- [ ] **Step 5: Commit**

```bash
git add mcp_server/src/remote/client.ts mcp_server/src/transport/remote.ts mcp_server/src/remote/client.test.ts
git commit -m "$(cat <<'EOF'
feat(clerk-auth): ConvexClient setAuth refresh callback for clerk locations

When createConvexClient is constructing a client for an authType=clerk
location, install a setAuth callback that:
- Returns cached access token if not yet expired (skip refresh)
- On forceRefreshToken=true or expiry: refreshAccessToken against Clerk,
  persist new tokens under cross-process config lock, return new access token
- Deduplicates concurrent in-process refreshes via refreshInFlight promise

Convex SDK calls this on connect and on every auth error, so reactive
subscriptions survive token rotation without bespoke retry logic.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task B8: End-to-end smoke test against KAI dev deployment

**Files:** none — manual verification

**Why:** Earlier tasks have unit + integration tests with mocked HTTP. This task is the live-fire test against a real KAI deployment with a real Clerk login.

Prerequisites:
- Part A merged into KAI's main (or available as a deployed branch)
- Task B0 Clerk Dashboard setup done
- KAI dev Convex deployment URL known
- A Clerk identity (test account) that's a member of a KAI org

- [ ] **Step 1: Configure ~/.cccollab/config.json**

```json
{
  "locations": {
    "kai-dev": {
      "url": "https://<kai-dev>.convex.cloud",
      "authType": "clerk",
      "clerkIssuer": "https://<clerk-instance>.clerk.accounts.dev",
      "clerkClientId": "cccollab-cli"
    }
  }
}
```

- [ ] **Step 2: Build cccollab MCP server**

```bash
cd /path/to/cccollab-worktree/mcp_server
yarn build
```

- [ ] **Step 3: Start a session locally pointing at the new build**

```bash
cd /path/to/cccollab/test
./start.sh kai-test
# or whichever path invokes the local build, per cccollab's repo conventions
```

- [ ] **Step 4: Invoke authenticate**

In the Claude Code session: call the `authenticate` tool with `location: "kai-dev"`. A browser should open Clerk's authorize page. Sign in. Callback should return. tokens saved in `~/.cccollab/config.json`.

- [ ] **Step 5: Invoke whoami**

Call `whoami` and confirm it returns the KAI user's email/name.

- [ ] **Step 6: Exercise channel + topic + DM**

- `join_channel { name: "smoke-test", location: "kai-dev" }`
- `start_topic { topic: "phase-2-smoke" }`
- `send_message_to_topic { text: "smoke test message" }`
- Check Convex dashboard: row appears in `cccollabMessages` with correct `fromUserId`, `senderName`, `ts`.

- [ ] **Step 7: Force a token refresh**

Wait > 60s with the session idle, then send another message. Verify it succeeds (the SDK should refresh the token automatically).

- [ ] **Step 8: Report findings**

If anything failed at steps 4-7, file follow-ups in CCC. Otherwise the smoke is done.

(No commit for this task — it's verification.)

---

## Task B9: Part B final verification + push

**Files:** none

- [ ] **Step 1: Full test suite in cccollab repo**

```bash
cd /path/to/cccollab-worktree
yarn test
yarn typecheck
yarn lint
yarn format:check
yarn build
```

Expected: all clean.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/clerk-auth
```

- [ ] **Step 3: Open PR** (or local merge — ask user per project convention)

---

# Cross-Repo Integration

After Parts A and B both land:

- [ ] **Smoke**: pair a deployed KAI dev with a fresh-built cccollab MCP server. Walk through B8 end-to-end.
- [ ] **Update CCC-37** to "Done" in Jira when both PRs are merged.
- [ ] **Communicate Phase 2 done** in the cccollab+kai merge topic.

---

## Self-Review

### Spec coverage
- Wire-compat from Phase 1 review: ✓ Tasks A4, A5, A6, A7, A8 cover the C3 / I4 / I5 / ESLint / DM-name items.
- kai-dev's Phase 2 architecture: ✓ Tasks B1-B7 implement the PKCE flow, discriminated config, setAuth refresh.
- Message tombstones: ✓ Task A1, A2.
- User-deleted cascade: ✓ Task A3.
- Clerk Dashboard setup: ✓ Task B0.

### Placeholders to flag
- Task B5 test step is light ("placeholder OK because primitives are well-tested in B3/B4") — implementer should add at least one runClerkPkce test using cccollab's existing test patterns. Acceptable trade-off for plan brevity.
- Task B7 references `loadLocationAuth` — may need to be extracted/added if not already present in `mcp_server/src/config/save.ts`. Implementer to verify.

### Type consistency
- `TokenSet` shape (`accessToken`, `refreshToken`, `accessTokenExpiresAt`) used uniformly across B4, B5, B7. ✓
- `authType` literal values (`'clerk'` | `'convex-google'`) consistent across B1, B6, B7. ✓
- `LocationConfig` shape used consistently. ✓

### Dependencies between tasks
- A1 → A2 (tombstone fields → populate them)
- A3 depends on A1 (tombstone for the keep-messages guarantee in cascade)
- A5 depends on A1 (returned shape includes senderName)
- A6 depends on A1 (return shape via the existing send-mutation pattern)
- B3 → B4 → B5 → B6 → B7 (PKCE primitives → orchestration → tool wiring → transport refresh)
- B7 depends on B2 (save needs to write accessTokenExpiresAt)
- B6 depends on B5

Ordering A1-A9 then B0-B9 is correct.
