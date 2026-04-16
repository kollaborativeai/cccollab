import { describe, it, expect } from 'vitest'
import { SessionManager } from '../src/session.js'

describe('SessionManager', () => {
  describe('session name derivation', () => {
    it('derives name as username | project', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.sessionName).toBe('stefan | dispatcher')
    })

    it('includes worktree suffix in project name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher-TWO', worktreeName: 'TWO' })
      expect(sm.sessionName).toBe('stefan | dispatcher-TWO')
    })

    it('falls back to unknown when cwd has no parseable name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/' })
      expect(sm.sessionName).toBe('stefan | unknown')
    })

    it('includes role when set', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setRole('architect')
      expect(sm.sessionName).toBe('stefan | dispatcher | architect')
    })

    it('allows project name override', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.overrideName('frontend-app')
      expect(sm.sessionName).toBe('stefan | frontend-app')
    })

    it('override + role works together', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.overrideName('frontend-app')
      sm.setRole('frontend')
      expect(sm.sessionName).toBe('stefan | frontend-app | frontend')
    })
  })

  describe('displayName', () => {
    it('falls back to username when no role set', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.displayName).toBe('stefan')
    })

    it('returns role when role is set', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setRole('architect')
      expect(sm.displayName).toBe('architect')
    })
  })

  describe('fmt', () => {
    it('prefixes text with displayName (username fallback when no role)', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.fmt('hello world')).toBe('*[stefan]*: hello world')
    })

    it('includes only role in prefix when role is set', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setRole('backend')
      expect(sm.fmt('hello')).toBe('*[backend]*: hello')
    })
  })

  describe('parse', () => {
    it('extracts sender and text from pipe-separated format', () => {
      expect(SessionManager.parse('*[stefan | dispatcher | architect]*: hello world')).toEqual({
        sender: 'stefan | dispatcher | architect', text: 'hello world',
      })
    })

    it('handles format without role', () => {
      expect(SessionManager.parse('*[stefan | dispatcher]*: hello')).toEqual({
        sender: 'stefan | dispatcher', text: 'hello',
      })
    })

    it('handles multiline messages', () => {
      expect(SessionManager.parse('*[bob | api | backend]*: line one\nline two')).toEqual({
        sender: 'bob | api | backend', text: 'line one\nline two',
      })
    })

    it('returns null for unformatted messages (human messages)', () => {
      expect(SessionManager.parse('just a regular message')).toBeNull()
    })

    it('returns null for empty messages', () => {
      expect(SessionManager.parse('')).toBeNull()
    })
  })

  describe('isSelf', () => {
    it('returns true when sender matches full session name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setRole('architect')
      expect(sm.isSelf('stefan | dispatcher | architect')).toBe(true)
    })

    it('returns true when sender matches displayName (role)', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.setRole('architect')
      expect(sm.isSelf('architect')).toBe(true)
    })

    it('returns true when sender matches displayName (username fallback)', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.isSelf('stefan')).toBe(true)
    })

    it('returns false for different session names', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.isSelf('carlos | api | backend')).toBe(false)
    })
  })
})
