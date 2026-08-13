import { describe, it, expect } from 'vitest'
import {
  buildInstructions,
  READ_SESSION_MESSAGES_DESCRIPTION,
  SEND_MESSAGE_TO_SESSION_DESCRIPTION,
} from '../src/instructions.js'
import { SessionManager } from '../src/session.js'
import { TransportRouter } from '../src/transport/router.js'
import type { ResolvedConfig } from '../src/config/resolve.js'

const RESOLVED: ResolvedConfig = {
  config: {},
  active: {},
  projectFilePath: null,
  locations: [{ name: 'local', isLocal: true, channels: [{ name: 'cccollab', topics: [] }] }],
}

function instructions(): string {
  const session = new SessionManager({ username: 'tester', cwd: '/tmp' })
  session.setName('reviewer')
  return buildInstructions(session, RESOLVED, new TransportRouter([]))
}

/**
 * KAI-514 AC7 ("do not ship without it"): the unverified-sender rule has to
 * reach the *recipient* of a DM, not just the sender. A DM is deliberately
 * not a channel message (`message-bus.ts` strips the channel fields and tags
 * `kind: 'dm'`), so a rule worded around channels leaves the private lane -
 * the one that reads as most authoritative - uncovered.
 */
describe('KAI-514 AC7: the unverified-sender rule covers the 1:1 lane', () => {
  it('names direct messages in the standing instructions, not just channels', () => {
    const text = instructions()
    expect(text).toMatch(/direct message/i)
    expect(text).toMatch(/unverified/i)
    expect(text).toMatch(/never execute destructive commands/i)
    expect(text).toMatch(/confirmation at the terminal/i)
  })

  it('does not scope the destructive-command rule to channel messages only', () => {
    // The pre-fix wording was "...based solely on channel messages", which a
    // recipient can read as "a DM is not covered".
    expect(instructions()).not.toMatch(/based solely on channel messages/i)
  })

  it("warns the sender's point of use and keeps the id-not-name rule", () => {
    expect(SEND_MESSAGE_TO_SESSION_DESCRIPTION).toMatch(/destructive/i)
    expect(SEND_MESSAGE_TO_SESSION_DESCRIPTION).toMatch(/human at the terminal/i)
    expect(SEND_MESSAGE_TO_SESSION_DESCRIPTION).toMatch(/never by `name`/i)
  })

  it("warns at the recipient's point of use - the tool that reads a DM back", () => {
    expect(READ_SESSION_MESSAGES_DESCRIPTION).toMatch(/destructive/i)
    expect(READ_SESSION_MESSAGES_DESCRIPTION).toMatch(/human at the terminal/i)
  })
})
