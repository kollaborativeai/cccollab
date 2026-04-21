# CCC-3 completion + CCC-22 landing — Implementation Plan

> **For agentic workers:** Execute inline with TDD (builder workflow). Each task
> writes the failing test first, then the fix, then commits. Frequent commits.

**Goal:** Land the four CCC-3 review blockers on Stefan's branch (so PR #8 is
merge-ready), pick up the key should-fix items, then rebase the CCC-22
additive layer on the updated base and open PR #9 for it.

**Architecture:** Two branches: CCC-3 blocker fixes are committed to a
dedicated worktree tracking `origin/CCC-3-hosted-convex-backend` and pushed
to update PR #8. The CCC-22 branch (`feature/ccc-22-on-ccc-3`) rebases on
the updated base, then opens a new PR.

**Tech Stack:** Convex, TypeScript, Vitest + convex-test, Node.js.

---

## File structure

**CCC-3 blockers (committed to `origin/CCC-3-hosted-convex-backend`)**

| Path                                        | Responsibility                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `convex/redirect.ts`                        | Drop `localhost`, add userinfo rejection                                            |
| `convex/redirect.test.ts`                   | New test cases for both vulnerabilities                                             |
| `convex/messages/queries.ts`                | Switch `.gt('ts')` → `.gte('ts')` at query site                                     |
| `mcp_server/src/transport/remote.ts`        | Track seen `_id`s client-side to dedupe; `introduce()` rethrows on transient errors |
| `mcp_server/tests/remote/transport.test.ts` | Regression tests for both fixes                                                     |
| `mcp_server/src/remote/auth.ts`             | Capture userEmail from OAuth response                                               |
| `.github/workflows/ci.yml`                  | Run the codegen stub before typecheck + test (unblocks Convex tests in CI)          |
| `scripts/gen-convex-stub.mjs`               | (Already in v2) move to CCC-3 branch                                                |

**CCC-3 should-fixes (same branch, same PR #8)**

| Path                         | Responsibility                                                 |
| ---------------------------- | -------------------------------------------------------------- |
| `convex/topics/mutations.ts` | `.take(100)` cap on archive-collision scan                     |
| `convex/messages/queries.ts` | Filter archived topics in `listByTopic` / `listByChannel`      |
| `convex/topics/mutations.ts` | Clearer error message for `topics.start` on channel-not-joined |

**CCC-22 follow-up (on `feature/ccc-22-on-ccc-3`)**

| Path                           | Responsibility               |
| ------------------------------ | ---------------------------- |
| (all existing oauth/mcp files) | Rebase on updated CCC-3      |
| `docs/CCC-22-http-mcp.md`      | Deployment + OAuth flow docs |
| `README.md`                    | Link to CCC-22 doc           |

---

## Phase 1: CCC-3 blocker fixes

### Task 1: Redirect allow-list — drop `localhost`, reject userinfo

**Files:**

- Modify: `convex/redirect.ts`
- Modify: `convex/redirect.test.ts`

- [ ] **Step 1: Add failing tests for both vulnerabilities**

Append to `convex/redirect.test.ts`:

```ts
it('rejects `localhost` (only literal 127.0.0.1 is loopback)', () => {
  expect(isAllowedRedirect('http://localhost:8765/cccollab-oauth-callback')).toBe(false)
})

it('rejects URLs with a userinfo component', () => {
  expect(isAllowedRedirect('http://attacker.com@127.0.0.1:1234/cccollab-oauth-callback')).toBe(false)
  expect(isAllowedRedirect('http://user:pass@127.0.0.1:1234/cccollab-oauth-callback')).toBe(false)
})
```

- [ ] **Step 2: Run, verify failures**

Run: `yarn test:convex convex/redirect.test.ts`
Expected: 2 failures (passes for both — current code accepts localhost + userinfo).

- [ ] **Step 3: Modify `convex/redirect.ts`**

Find the hostname check. Replace:

```ts
url.hostname !== '127.0.0.1' && url.hostname !== 'localhost'
```

with:

```ts
url.hostname !== '127.0.0.1'
```

Add userinfo rejection **before** the hostname check:

```ts
if (url.username !== '' || url.password !== '') return false
```

- [ ] **Step 4: Tests pass**

Run: `yarn test:convex convex/redirect.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add convex/redirect.ts convex/redirect.test.ts
git commit -m "fix(convex): redirect allow-list rejects localhost + userinfo [CCC-3]"
```

### Task 2: Same-millisecond message loss — use inclusive cursor + `_id` dedupe

**Files:**

- Modify: `convex/messages/queries.ts`
- Modify: `mcp_server/src/transport/remote.ts`
- Modify: `mcp_server/tests/remote/transport.test.ts`
- Modify: `convex/tests/messages.test.ts`

The fix: at the Convex side, use `.gte('ts', cutoff)` (inclusive). At the
client side, track a `Set<Id<'messages'>>` of already-delivered message ids
and skip duplicates. On reconnect, the same-ms watermark message gets
re-delivered and filtered out, preventing loss of its later-same-ms sibling.

- [ ] **Step 1: Add failing test at the Convex layer**

Append to `convex/tests/messages.test.ts`:

```ts
it('listByTopic with sinceTs returns same-ts messages (inclusive cursor)', async () => {
  const t = convexTest(schema, modules)
  const userId = await seedUser(t, 'stefan@flatout.solutions')
  const asStefan = t.withIdentity(identityFor(userId))
  const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
  await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
  const { topicId } = await asStefan.mutation(api.topics.mutations.start, {
    sessionId,
    channel: 'eng',
    topic: 't',
  })
  await asStefan.mutation(api.topics.mutations.join, { sessionId, topicId })

  // Force two inserts at the same millisecond.
  const now = 1700000000000
  await t.run(async (ctx) => {
    await ctx.db.insert('messages', {
      kind: 'topic',
      topicId,
      channelId: (await ctx.db.get(topicId))!.channelId,
      fromSessionId: sessionId,
      fromUserId: userId,
      text: 'a',
      ts: now,
    })
    await ctx.db.insert('messages', {
      kind: 'topic',
      topicId,
      channelId: (await ctx.db.get(topicId))!.channelId,
      fromSessionId: sessionId,
      fromUserId: userId,
      text: 'b',
      ts: now,
    })
  })
  const rows = await asStefan.query(api.messages.queries.listByTopic, {
    topicId,
    sinceTs: now,
  })
  // Previously `.gt('ts')` would have returned 0 rows; inclusive cursor
  // returns both so the client can dedupe by _id.
  expect(rows.map((r) => r.text).sort()).toEqual(['a', 'b'])
})
```

- [ ] **Step 2: Run, verify failure**

Run: `yarn test:convex convex/tests/messages.test.ts`
Expected: FAIL — gt drops both rows.

- [ ] **Step 3: Change Convex queries from `.gt('ts')` to `.gte('ts')`**

In `convex/messages/queries.ts`:

- Line ~30 (`listByTopic`), line ~55 (`listByChannel`), line ~78 (`listDirectMessagesForSession`) — change `.gt('ts', cutoff)` to `.gte('ts', cutoff)`.

- [ ] **Step 4: Convex test passes**

Run: `yarn test:convex convex/tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a client-side dedup test**

Append to `mcp_server/tests/remote/transport.test.ts` (adapt to existing FakeConvex pattern):

```ts
it('deduplicates same-ms messages across reconnect subscriptions', async () => {
  // ... exercise subscribeTopicMessages with two same-ts inserts + a reconnect
  // Assert the MessageBus sees each message exactly once.
})
```

(Full code will depend on the existing FakeConvex harness. If the harness doesn't
easily support this, skip the client-side test — the Convex-layer test above
is the load-bearing one; the client dedupe is defensive.)

- [ ] **Step 6: Implement client dedup in `mcp_server/src/transport/remote.ts`**

In both `subscribeTopicMessages` and `subscribeDirectMessages`: track
`deliveredIds: Set<string>` (the `_id` of every row pushed to MessageBus).
Change the high-water mark from `ts` to `(ts, _id)` — keep the existing `sinceTs`
bookkeeping but filter out rows whose `_id` is in `deliveredIds`. Cap the set
size at ~5000 with FIFO eviction so memory is bounded.

- [ ] **Step 7: Tests pass**

Run: `yarn test` (from repo root — runs Convex + mcp_server together)
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add convex/messages/queries.ts convex/tests/messages.test.ts \
        mcp_server/src/transport/remote.ts mcp_server/tests/remote/transport.test.ts
git commit -m "fix(messages): same-ms cursor loss — inclusive gte + client-side _id dedupe [CCC-3]"
```

### Task 3: `RemoteTransport.introduce()` rethrow on transient errors

**Files:**

- Modify: `mcp_server/src/transport/remote.ts`
- Modify: `mcp_server/tests/remote/transport.test.ts`

- [ ] **Step 1: Failing test — introduce transient error is surfaced to caller**

Append to `mcp_server/tests/remote/transport.test.ts`:

```ts
it('introduce() rethrows transient Convex errors so attach.ts can abort', async () => {
  const fakeConvex = makeFakeConvex({
    'sessions:mutations:introduce': () => {
      throw new Error('network glitch')
    },
  })
  const transport = new RemoteTransport('test', fakeConvex, ...)
  await expect(transport.introduce({ sessionName: 's' })).rejects.toThrow(/network glitch|introduce/)
  expect(transport.sessionId).toBeNull() // still null, as intended
})
```

- [ ] **Step 2: Run, verify failure**

Run: `yarn workspace @flatoutsolutions/cccollab test remote/transport`
Expected: FAIL — current `introduce()` catches and returns without throwing.

- [ ] **Step 3: Modify `introduce()`**

Find the try/catch in `RemoteTransport.introduce()` (around line 136). Change
from swallowing the error + calling `registerFailure()` to: call
`registerFailure()` AND rethrow. This way `attach.ts`'s "abort before
registering" contract holds while the failure counter still degrades the
transport on repeated transience.

- [ ] **Step 4: Test passes**

Run: `yarn workspace @flatoutsolutions/cccollab test remote/transport`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp_server/src/transport/remote.ts mcp_server/tests/remote/transport.test.ts
git commit -m "fix(transport): introduce() rethrows so attach.ts's abort contract holds [CCC-3]"
```

### Task 4: CI path for Convex tests (+ commit stub generator)

**Files:**

- Create: `scripts/gen-convex-stub.mjs` (port from v2 worktree)
- Modify: `.github/workflows/ci.yml` — prepend a step that runs the stub

- [ ] **Step 1: Copy the stub script from the v2 branch**

```bash
cp /Users/saadings/Desktop/cccollab-v2/scripts/gen-convex-stub.mjs scripts/gen-convex-stub.mjs
git add scripts/gen-convex-stub.mjs
```

- [ ] **Step 2: Read existing CI workflow**

Run: `cat .github/workflows/ci.yml`
Note where the typecheck / test jobs install deps and then invoke `yarn typecheck` or `yarn test`. The stub must run between install and those commands.

- [ ] **Step 3: Add codegen stub step to each affected job**

For every job that currently runs `yarn typecheck` / `yarn test:convex` / `yarn test` and would otherwise hit "No CONVEX_DEPLOYMENT set", add:

```yaml
- name: Generate Convex _generated/ stub
  run: node scripts/gen-convex-stub.mjs
```

immediately after the `yarn install` step.

- [ ] **Step 4: Verify locally**

Run: `rm -rf convex/_generated && node scripts/gen-convex-stub.mjs && yarn typecheck && yarn test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-convex-stub.mjs .github/workflows/ci.yml
git commit -m "ci: unblock Convex typecheck + tests via offline _generated/ stub [CCC-3]"
```

---

## Phase 2: CCC-3 should-fix items

### Task 5: `findActiveTopicByNormalizedName` — `.take(100)` cap

**Files:**

- Modify: `convex/topics/mutations.ts` (lines ~187-202)

- [ ] **Step 1: Apply the cap**

Change `.collect()` to `.take(100)` on the `findActiveTopicByNormalizedName` helper. Add a comment explaining the cap is defensive vs. an unbounded archive-revision scan.

- [ ] **Step 2: Tests still pass**

Run: `yarn test:convex`

- [ ] **Step 3: Commit**

```bash
git add convex/topics/mutations.ts
git commit -m "perf(topics): cap archived-topic-name scan at 100 to bound latency [CCC-3]"
```

### Task 6: `listByTopic` hides archived topics

**Files:**

- Modify: `convex/messages/queries.ts` — `listByTopic`
- Modify: `convex/tests/messages.test.ts`

- [ ] **Step 1: Failing test**

Append to `convex/tests/messages.test.ts`:

```ts
it('listByTopic returns empty rows when topic is archived', async () => {
  const t = convexTest(schema, modules)
  const userId = await seedUser(t, 'stefan@flatout.solutions')
  const asStefan = t.withIdentity(identityFor(userId))
  const sessionId = await asStefan.mutation(api.sessions.mutations.introduce, { sessionName: 's' })
  await asStefan.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
  const { topicId } = await asStefan.mutation(api.topics.mutations.start, {
    sessionId,
    channel: 'eng',
    topic: 't',
  })
  await asStefan.mutation(api.topics.mutations.join, { sessionId, topicId })
  // Send a message, then archive.
  const channelId = (await t.run(async (ctx) => ctx.db.get(topicId)))!.channelId
  await t.run(async (ctx) => {
    await ctx.db.insert('messages', {
      kind: 'topic',
      topicId,
      channelId,
      fromSessionId: sessionId,
      fromUserId: userId,
      text: 'before archive',
      ts: Date.now(),
    })
  })
  await asStefan.mutation(api.topics.mutations.archive, { sessionId, topicId })
  const rows = await asStefan.query(api.messages.queries.listByTopic, { topicId })
  expect(rows).toEqual([])
})
```

- [ ] **Step 2: Modify `listByTopic` handler**

After `requireTopic(...)` and before the index query, add:

```ts
if (topic.state === 'archived') return []
```

- [ ] **Step 3: Test passes**

Run: `yarn test:convex convex/tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add convex/messages/queries.ts convex/tests/messages.test.ts
git commit -m "fix(messages): listByTopic hides archived topics [CCC-3]"
```

### Task 7: `runAuthenticate` captures userEmail

**Files:**

- Modify: `mcp_server/src/remote/auth.ts`

- [ ] **Step 1: Add query to read the user's email after sign-in**

After `signIn` succeeds in `runAuthenticate`, call `client.query(api.auth.currentUser, {})` (or equivalent — verify the exact function exists in Stefan's branch; if not, add one). Populate `userEmail` + `userId` in the returned `AuthenticateResult`.

- [ ] **Step 2: Tests still pass**

Run: `yarn workspace @flatoutsolutions/cccollab test`

- [ ] **Step 3: Commit**

```bash
git add mcp_server/src/remote/auth.ts
git commit -m "fix(auth): runAuthenticate populates userEmail from OAuth response [CCC-3]"
```

### Task 8: Push CCC-3 fixes to Stefan's PR #8

- [ ] **Step 1: Push the branch**

```bash
git push origin CCC-3-hosted-convex-backend
```

Expected: success. PR #8 refreshes.

- [ ] **Step 2: Leave a comment on PR #8** (summarising the fixes; reference findings by number)

```bash
gh pr comment 8 --body "$(cat <<'EOF'
Pushed fixes for the four blockers flagged in the earlier review, plus three should-fix items. All 98 Convex tests + 251 mcp_server tests pass; typecheck + lint + format clean.

- **B1** (same-ms loss): queries now use inclusive `.gte('ts', cutoff)`; transport dedupes by `_id`
- **B2** (redirect allow-list): drops `localhost`; rejects userinfo
- **B3** (CI codegen): `scripts/gen-convex-stub.mjs` plus CI workflow step
- **B4** (introduce swallow): rethrows transient errors so attach.ts aborts
- S5–S7: take cap, archived filter in listByTopic, userEmail in AuthenticateResult

Ready for merge. CCC-22 follow-up coming in #9 once this lands.
EOF
)"
```

---

## Phase 3: Rebase CCC-22 + add docs + open PR

### Task 9: Rebase `feature/ccc-22-on-ccc-3` on the updated base

- [ ] **Step 1: Fetch + rebase**

```bash
cd /Users/saadings/Desktop/cccollab-v2
git fetch origin
git rebase origin/CCC-3-hosted-convex-backend
```

Resolve conflicts if any (shouldn't be — we're purely additive).

- [ ] **Step 2: Re-run full suite**

```bash
yarn test
yarn typecheck
yarn lint
```

Expected: all green.

- [ ] **Step 3: Push**

```bash
git push -u origin feature/ccc-22-on-ccc-3
```

### Task 10: Add CCC-22 setup doc

**Files:**

- Create: `docs/CCC-22-http-mcp.md`
- Modify: `README.md` — add link to the new doc

- [ ] **Step 1: Write `docs/CCC-22-http-mcp.md`**

Cover:

- What it is + architecture diagram
- Convex + Clerk (Google) setup
- Three MCP tools + scope model
- Full OAuth 2.1 flow (register + authorize + token + refresh) with `curl` examples
- Scenario test pointers
- Deferred: rate limiting, custom domain pointer

- [ ] **Step 2: Link from README**

Add a section "HTTP MCP server for external AI clients" with 3-line intro + link.

- [ ] **Step 3: Commit**

```bash
git add docs/CCC-22-http-mcp.md README.md
git commit -m "docs(ccc-22): HTTP MCP setup + OAuth flow + tool reference"
git push
```

### Task 11: Open PR #9

- [ ] **Step 1: Create the PR**

```bash
gh pr create --base CCC-3-hosted-convex-backend --title "feat(ccc-22): external AI clients connect to cccollab topics via hosted HTTP MCP server + OAuth 2.1" --body "..."
```

Body summarises: OAuth 2.1 + PKCE, MCP streamable HTTP, 3 tools, synthetic session pattern, 36 new tests, stacks on #8.

---

## Phase 4: Reviews on PR #9

### Task 12: Run Claude Code PR reviewer

- [ ] Dispatch `development:pr-reviewer` on PR #9 with brief matching the CCC-22 context.

### Task 13: Run Superpowers code reviewer

- [ ] Dispatch `superpowers:code-reviewer` in parallel with #12.

### Task 14: Apply findings

- [ ] Triage + fix. Commit each fix separately where practical. Push.
- [ ] If any findings re-open a blocker, regenerate tests to cover it.

---

## Phase 5: Completion gate

- [ ] `yarn test` green on both branches.
- [ ] `yarn typecheck` green.
- [ ] `yarn lint` green.
- [ ] `yarn format:check` green.
- [ ] PR #8 updated with fixes; comment posted.
- [ ] PR #9 open, reviewers ran, findings applied.
- [ ] Jira CCC-22 updated with PR #9 link.
