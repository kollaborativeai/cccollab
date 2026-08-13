import { describe, it, expect } from 'vitest'
import { SessionManager, sessionKey } from '../src/session.js'

describe('SessionManager', () => {
  describe('session name derivation', () => {
    it('derives name as username | project', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.sessionName).toBe('stefan | dispatcher')
    })

    it('includes worktree suffix in project name', () => {
      const sm = new SessionManager({
        username: 'stefan',
        cwd: '/Users/stefan/projects/dispatcher-TWO',
        worktreeName: 'TWO',
      })
      expect(sm.sessionName).toBe('stefan | dispatcher-TWO')
    })

    it('falls back to unknown when cwd has no parseable name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/' })
      expect(sm.sessionName).toBe('stefan | unknown')
    })

    it('includes name when set', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setName('architect')
      expect(sm.sessionName).toBe('stefan | dispatcher | architect')
    })
  })

  describe('displayName', () => {
    it('falls back to username when no name set', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.displayName).toBe('stefan')
    })

    it('returns name when set', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setName('architect')
      expect(sm.displayName).toBe('architect')
    })
  })

  describe('fmt', () => {
    it('prefixes text with displayName (username fallback)', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.fmt('hello world')).toBe('*[stefan]*: hello world')
    })

    it('uses name in prefix when set', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setName('backend')
      expect(sm.fmt('hello')).toBe('*[backend]*: hello')
    })
  })

  describe('parse', () => {
    it('extracts sender and text from formatted message', () => {
      expect(SessionManager.parse('*[stefan | dispatcher | architect]*: hello world')).toEqual({
        sender: 'stefan | dispatcher | architect',
        text: 'hello world',
      })
    })

    it('handles format without name', () => {
      expect(SessionManager.parse('*[stefan | dispatcher]*: hello')).toEqual({
        sender: 'stefan | dispatcher',
        text: 'hello',
      })
    })

    it('handles multiline messages', () => {
      expect(SessionManager.parse('*[bob | api | backend]*: line one\nline two')).toEqual({
        sender: 'bob | api | backend',
        text: 'line one\nline two',
      })
    })

    it('returns null for unformatted messages', () => {
      expect(SessionManager.parse('just a regular message')).toBeNull()
    })

    it('returns null for empty messages', () => {
      expect(SessionManager.parse('')).toBeNull()
    })
  })

  describe('sessionKey (KAI-415 stable-key resolver)', () => {
    it('anchors on the CC session UUID, not the name: same UUID + different name -> same key', () => {
      // This is the six-renames-a-day case. The name churned; the UUID did not.
      const runA = sessionKey({ sessionId: 'uuid-abc', cwd: '/projects/x' })
      const runB = sessionKey({ sessionId: 'uuid-abc', cwd: '/projects/x' })
      expect(runA).toBe('uuid-abc')
      expect(runB).toBe(runA)
    })

    it('returns null when no sessionId is declared (the optional case)', () => {
      expect(sessionKey({ cwd: '/projects/x', repo: 'x' })).toBeNull()
    })

    it('returns null when identity is absent entirely', () => {
      expect(sessionKey(undefined)).toBeNull()
    })

    it('resolves different sessionIds to different keys', () => {
      expect(sessionKey({ sessionId: 'uuid-abc' })).not.toBe(sessionKey({ sessionId: 'uuid-def' }))
    })

    // `sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? ''` is the ordinary
    // way a blank id arrives. `??` treats '' as "declared", so a blank id
    // would resolve to the non-null key '' â and KAI-415 anchors its
    // persisted state file on this key, so every blank-id session on the
    // machine would share one state file and restore each other's state.
    // A blank id carries no identifying information: it must read as
    // "none declared", which is the safe, name-keyed floor.
    it('returns null for an empty sessionId', () => {
      expect(sessionKey({ sessionId: '' })).toBeNull()
    })

    it('returns null for a whitespace-only sessionId', () => {
      expect(sessionKey({ sessionId: '   ' })).toBeNull()
    })

    it('does not hand two blank-id sessions the same non-null key', () => {
      const a = sessionKey({ sessionId: '', cwd: '/projects/a' })
      const b = sessionKey({ sessionId: '   ', cwd: '/projects/b' })
      // Both must decline to answer rather than agree on a shared key.
      expect(a).toBeNull()
      expect(b).toBeNull()
    })

    /**
     * C5. `sessionId` is self-declared, arrives unvalidated over the
     * unauthenticated broker as well as through the MCP schema, and this is
     * the resolver KAI-415 turns into a persisted-state FILE NAME. A key
     * containing path separators, a NUL, or control characters is not a key
     * â it is a path, and it must never be handed onward as if it were an
     * opaque identifier. Refusing here holds for every caller, including the
     * HTTP boundary that never sees the MCP schema.
     */
    it('refuses a sessionId carrying path separators', () => {
      expect(sessionKey({ sessionId: '../../../../tmp/pwn' })).toBeNull()
      expect(sessionKey({ sessionId: '/etc/passwd' })).toBeNull()
      expect(sessionKey({ sessionId: 'a\\b' })).toBeNull()
      expect(sessionKey({ sessionId: '..' })).toBeNull()
    })

    it('refuses a sessionId carrying a NUL or control character', () => {
      expect(sessionKey({ sessionId: 'uuid\0truncated' })).toBeNull()
      expect(sessionKey({ sessionId: 'uuid\nnewline' })).toBeNull()
    })

    it('refuses an absurdly long sessionId', () => {
      expect(sessionKey({ sessionId: 'x'.repeat(10_000) })).toBeNull()
    })

    /**
     * cc#37 FINDING-37. The guards ran against the TRIMMED id and the RAW one
     * was returned — so the checks and the accepted value disagreed. What that
     * let through is exactly what the guards exist to stop: `trim` removes tab,
     * newline, CR, VT and FF, all inside the U+0000..U+001F range
     * UNSAFE_SESSION_ID rejects. The broker's unauthenticated loopback
     * `POST /sessions` sanitizer is this function (`broker.ts`), and its
     * docstring promises the stored value "must survive sessionKey"; it then
     * re-served the un-survived value to every session on the machine, typed as
     * a clean SessionIdentity.
     */
    it('returns the trimmed sessionId, so no edge control character survives the guards', () => {
      expect(sessionKey({ sessionId: 'abc\n' })).toBe('abc')
      expect(sessionKey({ sessionId: '\tabc' })).toBe('abc')
      expect(sessionKey({ sessionId: 'abc\r\n' })).toBe('abc')
      expect(sessionKey({ sessionId: '  abc  ' })).toBe('abc')
    })

    it('returns a value that is itself within the length bound', () => {
      // 200 real characters plus padding: accepted (the bound is measured on
      // the trimmed value) but the returned key must be the 200, not the 202.
      const key = sessionKey({ sessionId: ` ${'x'.repeat(200)} ` })
      expect(key).toBe('x'.repeat(200))
      expect(key).toHaveLength(200)
    })

    it('still accepts an ordinary Claude Code session UUID', () => {
      const uuid = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
      expect(sessionKey({ sessionId: uuid })).toBe(uuid)
    })
  })

  /**
   * KAI-401: `introduce` is called from three places (the introduce tool,
   * `attachLocation`, and server startup) and only one of them remembered
   * to pass `identity`. Forwarding is structural rather than remembered:
   * one method owns the payload, so a field added to the session reaches
   * every transport by construction instead of by a maintainer noticing
   * two other call sites.
   */
  describe('introduceArgs (KAI-401 structural forwarding)', () => {
    it('carries every declared field', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/projects/cccollab' })
      sm.setName('architect')
      sm.setObjective('ship KAI-401')
      sm.setOrganizationId('org_a')
      sm.setIdentity({ sessionId: 'uuid-401', repo: 'cccollab', pid: 4321 })

      expect(sm.introduceArgs()).toEqual({
        sessionName: 'architect',
        objective: 'ship KAI-401',
        organizationId: 'org_a',
        identity: { sessionId: 'uuid-401', repo: 'cccollab', pid: 4321 },
      })
    })

    it('falls back to the display name and leaves undeclared fields undefined', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/projects/cccollab' })

      expect(sm.introduceArgs()).toEqual({
        sessionName: 'stefan',
        objective: undefined,
        organizationId: undefined,
        identity: undefined,
      })
    })

    it('reflects a re-introduce that drops the identity', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/projects/cccollab' })
      sm.setName('architect')
      sm.setIdentity({ sessionId: 'uuid-401' })
      sm.setIdentity(undefined)

      expect(sm.introduceArgs().identity).toBeUndefined()
    })
  })

  describe('isSelf', () => {
    it('returns true when sender matches full session name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setName('architect')
      expect(sm.isSelf('stefan | dispatcher | architect')).toBe(true)
    })

    it('returns true when sender matches displayName', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setName('architect')
      expect(sm.isSelf('architect')).toBe(true)
    })

    it('returns true when sender matches username fallback', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.isSelf('stefan')).toBe(true)
    })

    it('returns false for different names', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.isSelf('carlos | api | backend')).toBe(false)
    })
  })
})
