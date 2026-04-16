import { describe, it, expect, beforeEach } from 'vitest'
import { ActiveContext } from '../src/context.js'

describe('ActiveContext', () => {
  let ctx: ActiveContext

  beforeEach(() => { ctx = new ActiveContext() })

  describe('initial state', () => {
    it('hasChannel returns false', () => { expect(ctx.hasChannel()).toBe(false) })
    it('hasTopic returns false', () => { expect(ctx.hasTopic()).toBe(false) })
    it('getChannelId throws', () => { expect(() => ctx.getChannelId()).toThrow('No active channel') })
    it('getChannelName throws', () => { expect(() => ctx.getChannelName()).toThrow('No active channel') })
    it('getThreadTs throws', () => { expect(() => ctx.getThreadTs()).toThrow('No active topic') })
    it('getTopicName returns undefined', () => { expect(ctx.getTopicName()).toBeUndefined() })
    it('getTopicSource returns undefined', () => { expect(ctx.getTopicSource()).toBeUndefined() })
  })

  describe('setActiveChannel', () => {
    it('sets channel and reports hasChannel true', () => {
      ctx.setActiveChannel('C123', 'team-alpha')
      expect(ctx.hasChannel()).toBe(true)
      expect(ctx.getChannelId()).toBe('C123')
      expect(ctx.getChannelName()).toBe('team-alpha')
    })

    it('adds channel without clearing active topic', () => {
      ctx.setActiveChannel('C123', 'team-alpha')
      ctx.joinTopic('300.100', 'Auth refactor')
      expect(ctx.hasTopic()).toBe(true)

      ctx.setActiveChannel('C456', 'team-beta')
      expect(ctx.hasTopic()).toBe(true)
      expect(ctx.getThreadTs()).toBe('300.100')
    })
  })

  describe('joinTopic', () => {
    it('sets topic after channel is set', () => {
      ctx.setActiveChannel('C123', 'team-alpha')
      ctx.joinTopic('300.100', 'Auth refactor')
      expect(ctx.hasTopic()).toBe(true)
      expect(ctx.getThreadTs()).toBe('300.100')
      expect(ctx.getTopicName()).toBe('Auth refactor')
    })

    it('defaults source to slack', () => {
      ctx.setActiveChannel('C123', 'team-alpha')
      ctx.joinTopic('300.100', 'Auth refactor')
      expect(ctx.getTopicSource()).toBe('slack')
    })

    it('accepts explicit local source', () => {
      ctx.joinTopic('uuid-1', 'Local topic', 'local')
      expect(ctx.getTopicSource()).toBe('local')
      expect(ctx.getThreadTs()).toBe('uuid-1')
    })

    it('accepts explicit slack source', () => {
      ctx.setActiveChannel('C123', 'team-alpha')
      ctx.joinTopic('300.100', 'Slack topic', 'slack')
      expect(ctx.getTopicSource()).toBe('slack')
    })
  })

  describe('clearChannel', () => {
    it('clears channel and topic', () => {
      ctx.setActiveChannel('C123', 'team-alpha')
      ctx.joinTopic('300.100', 'Auth refactor')
      ctx.clearChannel()
      expect(ctx.hasChannel()).toBe(false)
      expect(ctx.hasTopic()).toBe(false)
      expect(() => ctx.getChannelId()).toThrow('No active channel')
      expect(() => ctx.getThreadTs()).toThrow('No active topic')
      expect(ctx.getTopicSource()).toBeUndefined()
    })
  })

  describe('clearTopic', () => {
    it('clears topic but keeps channel', () => {
      ctx.setActiveChannel('C123', 'team-alpha')
      ctx.joinTopic('300.100', 'Auth refactor')
      ctx.clearTopic()
      expect(ctx.hasChannel()).toBe(true)
      expect(ctx.hasTopic()).toBe(false)
      expect(ctx.getChannelId()).toBe('C123')
      expect(() => ctx.getThreadTs()).toThrow('No active topic')
      expect(ctx.getTopicSource()).toBeUndefined()
    })
  })

  describe('findJoinedTopic', () => {
    it('returns source in the result', () => {
      ctx.joinTopic('uuid-1', 'Local topic', 'local')
      const found = ctx.findJoinedTopic('local')
      expect(found).not.toBeNull()
      expect(found!.source).toBe('local')
      expect(found!.threadTs).toBe('uuid-1')
    })

    it('returns null when no match', () => {
      ctx.joinTopic('uuid-1', 'Local topic', 'local')
      expect(ctx.findJoinedTopic('nonexistent')).toBeNull()
    })

    it('returns null when multiple matches', () => {
      ctx.joinTopic('uuid-1', 'Auth local', 'local')
      ctx.joinTopic('300.100', 'Auth slack', 'slack')
      expect(ctx.findJoinedTopic('auth')).toBeNull()
    })
  })

  describe('getJoinedTopics', () => {
    it('returns source for each topic', () => {
      ctx.joinTopic('uuid-1', 'Local topic', 'local')
      ctx.joinTopic('300.100', 'Slack topic', 'slack')
      const topics = ctx.getJoinedTopics()
      expect(topics).toHaveLength(2)
      const local = topics.find((t) => t.threadTs === 'uuid-1')
      const slack = topics.find((t) => t.threadTs === '300.100')
      expect(local!.source).toBe('local')
      expect(slack!.source).toBe('slack')
    })
  })
})
