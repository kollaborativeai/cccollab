import { describe, it, expect } from 'vitest'
import { SessionManager } from '../src/session.js'

describe('SessionManager', () => {
  describe('session name derivation', () => {
    it('derives name from username and cwd repo name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.sessionName).toBe('stefan-dispatcher')
    })

    it('includes worktree suffix when present', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher-TWO', worktreeName: 'TWO' })
      expect(sm.sessionName).toBe('stefan-dispatcher-TWO')
    })

    it('falls back to username-unknown when cwd has no parseable name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/' })
      expect(sm.sessionName).toBe('stefan-unknown')
    })

    it('allows name override', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      sm.overrideName('stefan-frontend')
      expect(sm.sessionName).toBe('stefan-frontend')
    })
  })

  describe('fmt', () => {
    it('prefixes text with session identity', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.fmt('hello world')).toBe('*[stefan-dispatcher]*: hello world')
    })
  })

  describe('parse', () => {
    it('extracts session name and text from formatted message', () => {
      expect(SessionManager.parse('*[stefan-dispatcher]*: hello world')).toEqual({ sender: 'stefan-dispatcher', text: 'hello world' })
    })

    it('handles multiline messages', () => {
      expect(SessionManager.parse('*[bob-backend]*: line one\nline two\nline three')).toEqual({ sender: 'bob-backend', text: 'line one\nline two\nline three' })
    })

    it('returns null for unformatted messages (human messages)', () => {
      expect(SessionManager.parse('just a regular message')).toBeNull()
    })

    it('returns null for empty messages', () => {
      expect(SessionManager.parse('')).toBeNull()
    })
  })

  describe('isSelf', () => {
    it('returns true when sender matches session name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.isSelf('stefan-dispatcher')).toBe(true)
    })

    it('returns false for different session names', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/Users/stefan/projects/dispatcher' })
      expect(sm.isSelf('carlos-backend')).toBe(false)
    })
  })
})
