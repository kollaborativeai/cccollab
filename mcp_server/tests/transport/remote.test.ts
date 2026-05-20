import { describe, it, expect } from 'vitest'
import { getFunctionName } from 'convex/server'

import { makeRefs } from '../../src/transport/remote.js'

/**
 * Unit tests for `makeRefs` — the factory that builds the Convex
 * function-reference paths for KAI's deployment.
 *
 * KAI namespaces every callable under `cccollab/*` and flattens the
 * queries/mutations directory split, so each operation lives at
 * `cccollab/<module>:<name>`.
 *
 * `getFunctionName` from `convex/server` is the canonical way to turn an
 * `anyApi` proxy into its string path and is used here to make the
 * assertions deterministic without wiring a real ConvexClient.
 */

describe('makeRefs – cccollab/* flat namespace', () => {
  const refs = makeRefs()

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
    // KAI exposes the session-scoped query as `listJoinedForSession`; the
    // (legacy-named) slot is mapped to it.
    expect(getFunctionName(refs.topics.queries.listJoinedForUser)).toBe('cccollab/topics:listJoinedForSession')
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
