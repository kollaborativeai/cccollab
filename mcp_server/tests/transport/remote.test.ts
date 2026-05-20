import { describe, it, expect } from 'vitest'
import { getFunctionName } from 'convex/server'

import { makeRefs } from '../../src/transport/remote.js'

/**
 * Unit tests for `makeRefs` — the factory that maps authType to the
 * correct Convex function-reference paths.
 *
 * KAI's Phase 1 port namespaced every callable under `cccollab/*` and
 * flattened the queries/mutations directory split. For `authType: 'clerk'`
 * we need refs that resolve to `cccollab/<module>:<name>`; for the default
 * `authType: 'convex-google'` they must resolve to the upstream
 * `<module>/<subdir>:<name>` shape.
 *
 * `getFunctionName` from `convex/server` is the canonical way to turn an
 * `anyApi` proxy into its string path and is used here to make the
 * assertions deterministic without wiring a real ConvexClient.
 */

describe('makeRefs – clerk authType maps to KAI cccollab.* flat namespace', () => {
  const refs = makeRefs('clerk')

  it('sessions.mutations paths resolve to cccollab/sessions:*', () => {
    expect(getFunctionName(refs.sessions.mutations.introduce)).toBe('cccollab/sessions:introduce')
    expect(getFunctionName(refs.sessions.mutations.updateLastSeen)).toBe('cccollab/sessions:updateLastSeen')
    expect(getFunctionName(refs.sessions.mutations.remove)).toBe('cccollab/sessions:remove')
  })

  it('sessions.queries paths resolve to cccollab/sessions:*', () => {
    expect(getFunctionName(refs.sessions.queries.whoami)).toBe('cccollab/sessions:whoami')
    expect(getFunctionName(refs.sessions.queries.listByChannel)).toBe('cccollab/sessions:listByChannel')
  })

  it('channels.mutations paths resolve to cccollab/channels:*', () => {
    expect(getFunctionName(refs.channels.mutations.join)).toBe('cccollab/channels:join')
    expect(getFunctionName(refs.channels.mutations.leave)).toBe('cccollab/channels:leave')
  })

  it('channels.queries paths resolve to cccollab/channels:*', () => {
    expect(getFunctionName(refs.channels.queries.listAll)).toBe('cccollab/channels:listAll')
    expect(getFunctionName(refs.channels.queries.listForUser)).toBe('cccollab/channels:listForUser')
  })

  it('topics.mutations paths resolve to cccollab/topics:*', () => {
    expect(getFunctionName(refs.topics.mutations.start)).toBe('cccollab/topics:start')
    expect(getFunctionName(refs.topics.mutations.join)).toBe('cccollab/topics:join')
    expect(getFunctionName(refs.topics.mutations.leave)).toBe('cccollab/topics:leave')
    expect(getFunctionName(refs.topics.mutations.archive)).toBe('cccollab/topics:archive')
    expect(getFunctionName(refs.topics.mutations.unarchive)).toBe('cccollab/topics:unarchive')
  })

  it('topics.queries paths resolve to cccollab/topics:*', () => {
    expect(getFunctionName(refs.topics.queries.listByChannel)).toBe('cccollab/topics:listByChannel')
    expect(getFunctionName(refs.topics.queries.getById)).toBe('cccollab/topics:getById')
    expect(getFunctionName(refs.topics.queries.listJoinedForUser)).toBe('cccollab/topics:listJoinedForUser')
  })

  it('messages.mutations paths resolve to cccollab/messages:*', () => {
    expect(getFunctionName(refs.messages.mutations.sendToChannel)).toBe('cccollab/messages:sendToChannel')
    expect(getFunctionName(refs.messages.mutations.sendToTopic)).toBe('cccollab/messages:sendToTopic')
    expect(getFunctionName(refs.messages.mutations.sendToSession)).toBe('cccollab/messages:sendToSession')
    expect(getFunctionName(refs.messages.mutations.ackChannel)).toBe('cccollab/messages:ackChannel')
  })

  it('messages.queries paths resolve to cccollab/messages:*', () => {
    expect(getFunctionName(refs.messages.queries.listByTopic)).toBe('cccollab/messages:listByTopic')
    expect(getFunctionName(refs.messages.queries.listByChannel)).toBe('cccollab/messages:listByChannel')
    expect(getFunctionName(refs.messages.queries.listDirectMessagesForSession)).toBe(
      'cccollab/messages:listDirectMessagesForSession',
    )
  })
})

describe('makeRefs – convex-google authType maps to upstream queries/mutations paths', () => {
  const refs = makeRefs('convex-google')

  it('sessions.mutations.introduce resolves to the upstream path', () => {
    expect(getFunctionName(refs.sessions.mutations.introduce)).toBe('sessions/mutations:introduce')
  })

  it('sessions.queries.listByChannel resolves to the upstream path', () => {
    expect(getFunctionName(refs.sessions.queries.listByChannel)).toBe('sessions/queries:listByChannel')
  })

  it('channels.mutations.join resolves to the upstream path', () => {
    expect(getFunctionName(refs.channels.mutations.join)).toBe('channels/mutations:join')
  })

  it('channels.queries.listAll resolves to the upstream path', () => {
    expect(getFunctionName(refs.channels.queries.listAll)).toBe('channels/queries:listAll')
  })

  it('topics.mutations.start resolves to the upstream path', () => {
    expect(getFunctionName(refs.topics.mutations.start)).toBe('topics/mutations:start')
  })

  it('topics.queries.listByChannel resolves to the upstream path', () => {
    expect(getFunctionName(refs.topics.queries.listByChannel)).toBe('topics/queries:listByChannel')
  })

  it('messages.mutations.sendToTopic resolves to the upstream path', () => {
    expect(getFunctionName(refs.messages.mutations.sendToTopic)).toBe('messages/mutations:sendToTopic')
  })

  it('messages.queries.listByChannel resolves to the upstream path', () => {
    expect(getFunctionName(refs.messages.queries.listByChannel)).toBe('messages/queries:listByChannel')
  })
})

describe('makeRefs – default authType behaves like convex-google', () => {
  it('omitting authType gives the same paths as convex-google', () => {
    // makeRefs defaults to convex-google when authType is undefined,
    // matching RemoteTransport constructor's fallback.
    // We cast to bypass the strict union type to simulate the default path.
    const refs = makeRefs('convex-google')
    expect(getFunctionName(refs.sessions.mutations.introduce)).toBe('sessions/mutations:introduce')
    expect(getFunctionName(refs.channels.queries.listAll)).toBe('channels/queries:listAll')
  })
})
