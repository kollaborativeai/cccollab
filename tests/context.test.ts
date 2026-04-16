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
  })

  describe('setChannel', () => {
    it('sets channel and reports hasChannel true', () => {
      ctx.setChannel('C123', 'team-alpha')
      expect(ctx.hasChannel()).toBe(true)
      expect(ctx.getChannelId()).toBe('C123')
      expect(ctx.getChannelName()).toBe('team-alpha')
    })

    it('clears active topic when channel changes', () => {
      ctx.setChannel('C123', 'team-alpha')
      ctx.setTopic('300.100', 'Auth refactor')
      expect(ctx.hasTopic()).toBe(true)

      ctx.setChannel('C456', 'team-beta')
      expect(ctx.hasTopic()).toBe(false)
      expect(() => ctx.getThreadTs()).toThrow('No active topic')
      expect(ctx.getTopicName()).toBeUndefined()
    })
  })

  describe('setTopic', () => {
    it('sets topic after channel is set', () => {
      ctx.setChannel('C123', 'team-alpha')
      ctx.setTopic('300.100', 'Auth refactor')
      expect(ctx.hasTopic()).toBe(true)
      expect(ctx.getThreadTs()).toBe('300.100')
      expect(ctx.getTopicName()).toBe('Auth refactor')
    })
  })

  describe('clearChannel', () => {
    it('clears channel and topic', () => {
      ctx.setChannel('C123', 'team-alpha')
      ctx.setTopic('300.100', 'Auth refactor')
      ctx.clearChannel()
      expect(ctx.hasChannel()).toBe(false)
      expect(ctx.hasTopic()).toBe(false)
      expect(() => ctx.getChannelId()).toThrow('No active channel')
      expect(() => ctx.getThreadTs()).toThrow('No active topic')
    })
  })

  describe('clearTopic', () => {
    it('clears topic but keeps channel', () => {
      ctx.setChannel('C123', 'team-alpha')
      ctx.setTopic('300.100', 'Auth refactor')
      ctx.clearTopic()
      expect(ctx.hasChannel()).toBe(true)
      expect(ctx.hasTopic()).toBe(false)
      expect(ctx.getChannelId()).toBe('C123')
      expect(() => ctx.getThreadTs()).toThrow('No active topic')
    })
  })
})
