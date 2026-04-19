import { describe, it, expect, beforeEach } from 'vitest'
import { ActiveContext } from '../src/context.js'

describe('ActiveContext', () => {
  let ctx: ActiveContext

  beforeEach(() => { ctx = new ActiveContext() })

  describe('initial state', () => {
    it('hasTopic returns false', () => { expect(ctx.hasTopic()).toBe(false) })
    it('getThreadTs throws', () => { expect(() => ctx.getThreadTs()).toThrow('No active topic') })
    it('getTopicName returns undefined', () => { expect(ctx.getTopicName()).toBeUndefined() })
    it('getTopicSource returns undefined', () => { expect(ctx.getTopicSource()).toBeUndefined() })
    it('isLocalJoined returns false', () => { expect(ctx.isLocalJoined()).toBe(false) })
  })

  describe('joinLocalChannel', () => {
    it('flips isLocalJoined to true', () => {
      ctx.joinLocalChannel()
      expect(ctx.isLocalJoined()).toBe(true)
    })
  })

  describe('joinTopic', () => {
    it('sets topic and source', () => {
      ctx.joinTopic('uuid-1', 'Auth refactor', 'local')
      expect(ctx.hasTopic()).toBe(true)
      expect(ctx.getThreadTs()).toBe('uuid-1')
      expect(ctx.getTopicName()).toBe('Auth refactor')
      expect(ctx.getTopicSource()).toBe('local')
    })
  })

  describe('leaveTopic', () => {
    it('removes a joined topic and clears active if it was active', () => {
      ctx.joinTopic('uuid-1', 'Auth refactor', 'local')
      ctx.leaveTopic('uuid-1')
      expect(ctx.hasTopic()).toBe(false)
      expect(ctx.isTopicJoined('uuid-1')).toBe(false)
      expect(() => ctx.getThreadTs()).toThrow('No active topic')
      expect(ctx.getTopicSource()).toBeUndefined()
    })

    it('does not clear active when a different topic is left', () => {
      ctx.joinTopic('uuid-1', 'Auth refactor', 'local')
      ctx.joinTopic('uuid-2', 'DB migration', 'local')
      // uuid-2 is now active; leaving uuid-1 should keep uuid-2 active
      ctx.leaveTopic('uuid-1')
      expect(ctx.hasTopic()).toBe(true)
      expect(ctx.getThreadTs()).toBe('uuid-2')
    })
  })

  describe('clearTopic', () => {
    it('clears the active topic', () => {
      ctx.joinTopic('uuid-1', 'Auth refactor', 'local')
      ctx.clearTopic()
      expect(ctx.hasTopic()).toBe(false)
      expect(() => ctx.getThreadTs()).toThrow('No active topic')
      expect(ctx.getTopicSource()).toBeUndefined()
    })
  })

  describe('findJoinedTopic', () => {
    it('returns match with source in the result', () => {
      ctx.joinTopic('uuid-1', 'Local topic', 'local')
      const found = ctx.findJoinedTopic('local')
      expect(found).not.toBeNull()
      expect(found!.source).toBe('local')
      expect(found!.threadTs).toBe('uuid-1')
    })

    it('matches by exact threadTs/id', () => {
      ctx.joinTopic('uuid-1', 'Local topic', 'local')
      const found = ctx.findJoinedTopic('uuid-1')
      expect(found).not.toBeNull()
      expect(found!.threadTs).toBe('uuid-1')
    })

    it('returns null when no match', () => {
      ctx.joinTopic('uuid-1', 'Local topic', 'local')
      expect(ctx.findJoinedTopic('nonexistent')).toBeNull()
    })

    it('returns null when multiple fuzzy matches', () => {
      ctx.joinTopic('uuid-1', 'Auth one', 'local')
      ctx.joinTopic('uuid-2', 'Auth two', 'local')
      expect(ctx.findJoinedTopic('auth')).toBeNull()
    })
  })

  describe('getJoinedTopics', () => {
    it('returns all joined topics with source', () => {
      ctx.joinTopic('uuid-1', 'First', 'local')
      ctx.joinTopic('uuid-2', 'Second', 'local')
      const topics = ctx.getJoinedTopics()
      expect(topics).toHaveLength(2)
      expect(topics.every((t) => t.source === 'local')).toBe(true)
    })
  })
})
