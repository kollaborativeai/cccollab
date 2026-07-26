import { describe, it, expect } from 'vitest'
import { SessionManager, sessionKey, identityFromEnv, mergeIdentity } from '../src/session.js'

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
  })

  describe('identityFromEnv (KAI-415)', () => {
    it('reads the session UUID Claude Code exports, so persistence keys itself with no user action', () => {
      const identity = identityFromEnv({ CLAUDE_CODE_SESSION_ID: 'uuid-from-env' }, '/projects/x', 4321)
      expect(identity?.sessionId).toBe('uuid-from-env')
      expect(identity?.cwd).toBe('/projects/x')
      expect(identity?.pid).toBe(4321)
    })

    it('yields NO sessionId when the env var is unset - never an empty string that would key a file', () => {
      const identity = identityFromEnv({}, '/projects/x', 4321)
      expect(identity?.sessionId).toBeUndefined()
      expect(sessionKey(identity)).toBeNull()
    })

    it('treats a blank / whitespace env var as absent rather than as a key', () => {
      expect(sessionKey(identityFromEnv({ CLAUDE_CODE_SESSION_ID: '   ' }, '/projects/x', 1))).toBeNull()
    })

    it('trims surrounding whitespace off an otherwise valid UUID', () => {
      expect(identityFromEnv({ CLAUDE_CODE_SESSION_ID: ' uuid-abc \n' }, '/x', 1)?.sessionId).toBe('uuid-abc')
    })
  })

  describe('mergeIdentity (KAI-415)', () => {
    const base = { sessionId: 'uuid-env', cwd: '/projects/env-cwd', pid: 111 }

    it('lets a declared field override the env-derived base (KAI-401 contract preserved)', () => {
      const merged = mergeIdentity(base, { cwd: '/projects/declared', repo: 'cccollab' })
      expect(merged?.cwd).toBe('/projects/declared')
      expect(merged?.repo).toBe('cccollab')
    })

    it('keeps env-derived fields the declaration omits - an introduce without sessionId must not wipe it', () => {
      // The regression this guards: introduce({name, identity:{repo}}) blowing
      // away the env sessionId would silently disable persistence for the session.
      const merged = mergeIdentity(base, { repo: 'cccollab' })
      expect(merged?.sessionId).toBe('uuid-env')
      expect(merged?.cwd).toBe('/projects/env-cwd')
      expect(merged?.pid).toBe(111)
    })

    it('keeps the whole base when nothing is declared at all', () => {
      expect(mergeIdentity(base, undefined)).toEqual(base)
    })

    it('takes the declaration wholesale when there is no base', () => {
      expect(mergeIdentity(undefined, { repo: 'cccollab' })).toEqual({ repo: 'cccollab' })
    })

    it('stays undefined when neither side has anything - no identity key on the wire (KAI-401)', () => {
      expect(mergeIdentity(undefined, undefined)).toBeUndefined()
      expect(mergeIdentity({}, {})).toBeUndefined()
    })

    it('ignores explicitly-undefined declared fields instead of using them to erase the base', () => {
      const merged = mergeIdentity(base, { sessionId: undefined, repo: 'cccollab' })
      expect(merged?.sessionId).toBe('uuid-env')
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
