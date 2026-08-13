/**
 * cc#32 FINDING-32a — a swallowed `organizations.listForUser` failure must not
 * be allowed to authorize a destructive migration, and must not be allowed to
 * replace a canonical binding with a handle it could not resolve.
 *
 * These tests drive the REAL `RemoteTransport` over a stub `ConvexClient`, so
 * the empty catalog is produced by production code — `listOrganizations`
 * catching, calling `registerFailure` and returning `[]` (remote.ts) — rather
 * than by a fake handing back `[]` directly. Mocking the blip in at the
 * transport boundary would prove only that the two sides agree; this proves
 * that the real swallow reaches the real decision.
 */
import { describe, it, expect, vi } from 'vitest'
import { getFunctionName } from 'convex/server'
import type { ConvexClient } from 'convex/browser'
import { RemoteTransport } from '../../src/transport/remote.js'
import { handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'
import { TransportRouter } from '../../src/transport/router.js'
import type { MessageBus } from '../../src/message-bus.js'

/** One org, addressable by id `org_xxx` or slug `acme` — the pair cc#31 tells
 *  agents to hand back and forth via `whoami.organizationSlug`. */
const ORGS = [{ id: 'org_xxx', name: 'Acme', slug: 'acme' }]

/**
 * A real RemoteTransport whose backend is a stub. `outage` flips ONLY
 * `organizations.listForUser` to throw — a dropped websocket frame, an auth
 * refresh, a cold backend. Everything else keeps working, which is the point:
 * the transport stays enabled and `introduce` still succeeds.
 */
function makeTransport(outage: { active: boolean }): RemoteTransport {
  const client = {
    query: vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as never)
      if (name.includes('organizations') && name.includes('listForUser')) {
        if (outage.active) throw new Error('websocket closed before response')
        return ORGS
      }
      if (name.includes('listAll')) return [{ _id: 'chan_1', name: 'kai' }]
      return []
    }),
    mutation: vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as never)
      if (name.includes('introduce')) return 'session_1'
      if (name.includes('channels') && name.includes('join')) return { channelId: 'chan_1', subscriberCount: 1 }
      return undefined
    }),
    onUpdate: vi.fn(() => () => {}),
    setAuth: vi.fn(),
    close: vi.fn(),
  }
  return new RemoteTransport({ client: client as unknown as ConvexClient, source: 'remote', log: () => {} })
}

function makeDeps(transport: RemoteTransport): IdentityToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    context: new ActiveContext(),
    router: new TransportRouter([transport]),
    // No `remoteTopicUnsubscribes` / `remoteChannelUnsubscribes`: KAI-418
    // removed the shared unsubscribe maps and the transport owns feed
    // lifecycle now. tsc rejects them here even though the suite ignored them.
    messageBus: { push: vi.fn(async () => {}) } as unknown as MessageBus,
  }
}

/** Bind the session to `org_xxx` the honest way — a healthy introduce by id —
 *  then join a channel and a topic at that location, so a false org-change has
 *  something real to destroy. */
async function bindAndJoin(deps: IdentityToolDeps): Promise<void> {
  deps.context.joinChannel('kai', 'cccollab.json', 'remote')
  await handleIdentityTool('introduce', { name: 'a', organization: 'org_xxx' }, deps)
  deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
  expect(deps.session.getOrganizationFor('remote')).toBe('org_xxx')
}

describe('cc#32 FINDING-32a — a blipped org catalog must not drive a destructive migration', () => {
  it('does not treat a same-org slug as an org change when the org list blipped', async () => {
    // RED without the fix: the catalog is `[]`, `canonicalizeOrganizationId`
    // passes both handles through unchanged, `"acme" !== "org_xxx"`, and the
    // location is marked org-changed — the exact raw string compare that
    // canonicalization was added to replace.
    const outage = { active: false }
    const deps = makeDeps(makeTransport(outage))
    await bindAndJoin(deps)

    outage.active = true
    const result = JSON.parse(await handleIdentityTool('introduce', { name: 'a', organization: 'acme' }, deps)) as {
      droppedTopics?: unknown[]
    }

    expect(result.droppedTopics).toBeUndefined()
    expect(deps.context.getJoinedTopics().map((t) => t.threadTs)).toEqual(['topic_1'])
  })

  it('does not replace a canonical binding with a handle the blipped catalog could not resolve', async () => {
    // RED without the fix: the fan-out stores `canonicalOrganization`, which on
    // a blip IS the raw handle, so the binding becomes "acme". The cost is not
    // that it never recovers — a clean introduce re-resolves the slug — but
    // that while the outage LASTS, the corrupted binding makes the next
    // introduce-by-id compare unequal and destroy a second time, where an
    // untouched binding would have compared equal and done nothing.
    const outage = { active: false }
    const deps = makeDeps(makeTransport(outage))
    await bindAndJoin(deps)

    outage.active = true
    await handleIdentityTool('introduce', { name: 'a', organization: 'acme' }, deps)

    expect(deps.session.getOrganizationFor('remote')).toBe('org_xxx')

    // Still down. The agent re-introduces by id (read from list_organizations,
    // or a restart). With the binding intact this is a no-op; with it poisoned
    // it is a second teardown.
    if (deps.context.getJoinedTopics().length === 0) deps.context.joinTopic('topic_1', 'KAI-408', 'kai', 'remote')
    const second = JSON.parse(await handleIdentityTool('introduce', { name: 'a', organization: 'org_xxx' }, deps)) as {
      droppedTopics?: unknown[]
    }

    expect(second.droppedTopics).toBeUndefined()
    expect(deps.context.getJoinedTopics().map((t) => t.threadTs)).toEqual(['topic_1'])
  })

  it('still records a FIRST binding during an outage, so the C2 first-bind arm does not re-fire', async () => {
    // Guard on the fix itself: "do not overwrite a canonical binding" must not
    // become "never store anything". A session whose first introduce lands
    // during an outage has no binding to protect, and refusing to record one
    // would leave `previousOrg` undefined so every later introduce re-took the
    // first-bind migration arm for as long as the outage lasted.
    const outage = { active: true }
    const deps = makeDeps(makeTransport(outage))
    deps.context.joinChannel('kai', 'cccollab.json', 'remote')

    await handleIdentityTool('introduce', { name: 'a', organization: 'acme' }, deps)

    expect(deps.session.getOrganizationFor('remote')).toBe('acme')
  })

  it('still detects a genuine org change once the catalog is readable', async () => {
    // Non-vacuity: the fix must not turn the detector off. With a healthy
    // catalog holding both orgs, moving to a different one is still a
    // migration — teardown, and the foreign-org topic dropped.
    const outage = { active: false }
    const twoOrgs = [...ORGS, { id: 'org_yyy', name: 'Beta', slug: 'beta' }]
    const client = {
      query: vi.fn(async (ref: unknown) => {
        const name = getFunctionName(ref as never)
        if (name.includes('organizations') && name.includes('listForUser')) return twoOrgs
        if (name.includes('listAll')) return [{ _id: 'chan_1', name: 'kai' }]
        return []
      }),
      mutation: vi.fn(async (ref: unknown) => {
        const name = getFunctionName(ref as never)
        if (name.includes('introduce')) return 'session_1'
        if (name.includes('channels') && name.includes('join')) return { channelId: 'chan_1', subscriberCount: 1 }
        return undefined
      }),
      onUpdate: vi.fn(() => () => {}),
      setAuth: vi.fn(),
      close: vi.fn(),
    }
    void outage
    const deps = makeDeps(
      new RemoteTransport({ client: client as unknown as ConvexClient, source: 'remote', log: () => {} }),
    )
    await bindAndJoin(deps)

    const result = JSON.parse(await handleIdentityTool('introduce', { name: 'a', organization: 'beta' }, deps)) as {
      droppedTopics?: Array<{ topic: string }>
    }

    expect(result.droppedTopics).toEqual([{ topic: 'KAI-408', channel: 'kai', location: 'remote' }])
    expect(deps.session.getOrganizationFor('remote')).toBe('org_yyy')
  })
})
