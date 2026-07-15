import { describe, it, expect, beforeEach } from 'vitest'
import { ActiveContext } from '../src/context.js'

describe('ActiveContext', () => {
  let ctx: ActiveContext

  beforeEach(() => {
    ctx = new ActiveContext()
  })

  describe('initial state', () => {
    it('hasTopic returns false', () => {
      expect(ctx.hasTopic()).toBe(false)
    })
    it('getThreadTs throws', () => {
      expect(() => ctx.getThreadTs()).toThrow('No active topic')
    })
    it('getTopicName returns undefined', () => {
      expect(ctx.getTopicName()).toBeUndefined()
    })
    it('getTopicChannel returns undefined', () => {
      expect(ctx.getTopicChannel()).toBeUndefined()
    })
    it('getActiveChannel returns undefined', () => {
      expect(ctx.getActiveChannel()).toBeUndefined()
    })
    it('getSubscribedChannels returns empty', () => {
      expect(ctx.getSubscribedChannels()).toEqual([])
    })
  })

  describe('joinChannel', () => {
    it('first channel becomes active', () => {
      const { channel, becameActive } = ctx.joinChannel('default', 'fallback')
      expect(channel).toBe('default')
      expect(becameActive).toBe(true)
      expect(ctx.getActiveChannel()).toBe('default')
      expect(ctx.isChannelSubscribed('default')).toBe(true)
      expect(ctx.getChannelSource('default')).toBe('fallback')
    })

    it('second channel does not replace active', () => {
      ctx.joinChannel('default', 'fallback')
      const { becameActive } = ctx.joinChannel('project_x', 'manual')
      expect(becameActive).toBe(false)
      expect(ctx.getActiveChannel()).toBe('default')
      expect(ctx.isChannelSubscribed('project_x')).toBe(true)
    })

    it('normalizes name (trim+lowercase)', () => {
      ctx.joinChannel('  Project_X  ', 'manual')
      expect(ctx.isChannelSubscribed('project_x')).toBe(true)
      expect(ctx.isChannelSubscribed('PROJECT_X')).toBe(true)
      expect(ctx.getActiveChannel()).toBe('project_x')
    })

    it('is idempotent (no duplicate subscriptions)', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinChannel('default', 'manual')
      const channels = ctx.getSubscribedChannels()
      expect(channels).toHaveLength(1)
      expect(channels[0]!.source).toBe('fallback')
    })

    it('rejects empty channel names', () => {
      expect(() => ctx.joinChannel('   ', 'manual')).toThrow('non-empty')
    })
  })

  describe('leaveChannel', () => {
    it('leaving active with another subscribed picks it as new active', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinChannel('project_x', 'manual')
      const { newActive } = ctx.leaveChannel('default')
      expect(newActive).toEqual({ name: 'project_x', location: 'local' })
      expect(ctx.isChannelSubscribed('default')).toBe(false)
    })

    it('leaving the only channel clears active', () => {
      ctx.joinChannel('default', 'fallback')
      const { newActive } = ctx.leaveChannel('default')
      expect(newActive).toBeUndefined()
      expect(ctx.getActiveChannel()).toBeUndefined()
    })

    it('leaving a non-active channel does not change active', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinChannel('project_x', 'manual')
      ctx.leaveChannel('project_x')
      expect(ctx.getActiveChannel()).toBe('default')
    })

    it('leaving drops any joined topics in that channel', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinTopic('uuid-1', 'Topic', 'default')
      ctx.leaveChannel('default')
      expect(ctx.isTopicJoined('uuid-1')).toBe(false)
      expect(ctx.hasTopic()).toBe(false)
    })
  })

  describe('setActiveChannel', () => {
    it('switches active among subscribed channels', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinChannel('project_x', 'manual')
      ctx.setActiveChannel('project_x')
      expect(ctx.getActiveChannel()).toBe('project_x')
    })

    it('throws when not subscribed', () => {
      expect(() => ctx.setActiveChannel('foo')).toThrow('Not subscribed')
    })
  })

  describe('joinTopic', () => {
    it('sets topic and channel', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinTopic('uuid-1', 'Auth refactor', 'default')
      expect(ctx.hasTopic()).toBe(true)
      expect(ctx.getThreadTs()).toBe('uuid-1')
      expect(ctx.getTopicName()).toBe('Auth refactor')
      expect(ctx.getTopicChannel()).toBe('default')
    })

    it('rejects topic in unsubscribed channel', () => {
      expect(() => ctx.joinTopic('uuid-1', 'X', 'missing')).toThrow('not subscribed')
    })
  })

  describe('leaveTopic', () => {
    it('removes a joined topic and clears active if it was active', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinTopic('uuid-1', 'Auth refactor', 'default')
      ctx.leaveTopic('uuid-1')
      expect(ctx.hasTopic()).toBe(false)
      expect(ctx.isTopicJoined('uuid-1')).toBe(false)
    })

    it('does not clear active when a different topic is left', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinTopic('uuid-1', 'Auth refactor', 'default')
      ctx.joinTopic('uuid-2', 'DB migration', 'default')
      ctx.leaveTopic('uuid-1')
      expect(ctx.hasTopic()).toBe(true)
      expect(ctx.getThreadTs()).toBe('uuid-2')
    })
  })

  describe('findJoinedTopic', () => {
    it('returns match with channel in the result', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinTopic('uuid-1', 'Local topic', 'default')
      const found = ctx.findJoinedTopic('local')
      expect(found).not.toBeNull()
      expect(found!.channel).toBe('default')
      expect(found!.threadTs).toBe('uuid-1')
    })

    it('matches by exact threadTs/id', () => {
      ctx.joinChannel('default', 'fallback')
      ctx.joinTopic('uuid-1', 'Local topic', 'default')
      const found = ctx.findJoinedTopic('uuid-1')
      expect(found!.threadTs).toBe('uuid-1')
    })

    it('returns null when multiple fuzzy matches (e.g. same name in different channels)', () => {
      ctx.joinChannel('a', 'manual')
      ctx.joinChannel('b', 'manual')
      ctx.joinTopic('uuid-1', 'shared', 'a')
      ctx.joinTopic('uuid-2', 'shared also', 'b')
      expect(ctx.findJoinedTopic('shared')).not.toBeNull()
      ctx.joinTopic('uuid-3', 'shared', 'b')
      expect(ctx.findJoinedTopic('shared')).toBeNull()
    })
  })

  describe('getChannelLocation', () => {
    it('returns the location for a subscription at an arbitrary (non-local, non-remote) name', () => {
      ctx.joinChannel('dev', 'cccollab.json', 'flatout')
      expect(ctx.getChannelLocation('dev')).toBe('flatout')
    })

    it('prefers local on a tie with another location', () => {
      ctx.joinChannel('dev', 'manual', 'flatout')
      ctx.joinChannel('dev', 'manual', 'local')
      expect(ctx.getChannelLocation('dev')).toBe('local')
    })

    it('returns undefined when the channel is not subscribed anywhere', () => {
      ctx.joinChannel('dev', 'manual', 'flatout')
      expect(ctx.getChannelLocation('other')).toBeUndefined()
    })
  })

  describe('getJoinedTopics', () => {
    it('returns all joined topics with channel', () => {
      ctx.joinChannel('a', 'manual')
      ctx.joinChannel('b', 'manual')
      ctx.joinTopic('uuid-1', 'First', 'a')
      ctx.joinTopic('uuid-2', 'Second', 'b')
      const topics = ctx.getJoinedTopics()
      expect(topics).toHaveLength(2)
      expect(topics.map((t) => t.channel).sort()).toEqual(['a', 'b'])
    })
  })

  describe('onChange hook (KAI-415 persistence)', () => {
    // The hook is what mirrors context to disk. It must fire on EVERY
    // mutation: a mutation that forgets to fire it is a subscription that
    // silently fails to survive a restart - the exact bug KAI-415 fixes,
    // reintroduced one method at a time. So this suite enumerates the
    // mutators rather than spot-checking a couple.
    let fired: number
    let ctx2: ActiveContext

    beforeEach(() => {
      fired = 0
      ctx2 = new ActiveContext(() => {
        fired++
      })
    })

    it('fires on joinChannel', () => {
      ctx2.joinChannel('dev', 'manual')
      expect(fired).toBe(1)
    })

    it('fires on leaveChannel', () => {
      ctx2.joinChannel('dev', 'manual')
      fired = 0
      ctx2.leaveChannel('dev')
      expect(fired).toBe(1)
    })

    it('fires on setActiveChannel', () => {
      ctx2.joinChannel('dev', 'manual')
      ctx2.joinChannel('ops', 'manual')
      fired = 0
      ctx2.setActiveChannel('ops')
      expect(fired).toBe(1)
    })

    it('fires on joinTopic', () => {
      ctx2.joinChannel('dev', 'manual')
      fired = 0
      ctx2.joinTopic('uuid-1', 'Auth', 'dev')
      expect(fired).toBe(1)
    })

    it('fires on leaveTopic', () => {
      ctx2.joinChannel('dev', 'manual')
      ctx2.joinTopic('uuid-1', 'Auth', 'dev')
      fired = 0
      ctx2.leaveTopic('uuid-1')
      expect(fired).toBe(1)
    })

    it('fires on clearTopic', () => {
      ctx2.joinChannel('dev', 'manual')
      ctx2.joinTopic('uuid-1', 'Auth', 'dev')
      fired = 0
      ctx2.clearTopic()
      expect(fired).toBe(1)
    })

    it('does not fire on reads - persisting on every whoami would be pure churn', () => {
      ctx2.joinChannel('dev', 'manual')
      ctx2.joinTopic('uuid-1', 'Auth', 'dev')
      fired = 0
      ctx2.getSubscribedChannels()
      ctx2.getJoinedTopics()
      ctx2.getActiveChannelRef()
      ctx2.isTopicJoined('uuid-1')
      ctx2.getTopicName()
      ctx2.findJoinedTopic('Auth')
      expect(fired).toBe(0)
    })

    it('does not fire when a mutation throws - nothing changed, nothing to persist', () => {
      expect(() => ctx2.setActiveChannel('never-joined')).toThrow()
      expect(fired).toBe(0)
    })

    it('works with no hook at all (the hook is optional)', () => {
      const plain = new ActiveContext()
      expect(() => plain.joinChannel('dev', 'manual')).not.toThrow()
    })

    it('never lets a failing hook break the operation the user asked for', () => {
      // Persistence is a side benefit. A full disk must not make join_channel
      // fail - the session should still work, just without a safety net.
      const ctx3 = new ActiveContext(() => {
        throw new Error('disk full')
      })
      expect(() => ctx3.joinChannel('dev', 'manual')).not.toThrow()
      expect(ctx3.isChannelSubscribed('dev')).toBe(true)
    })
  })
})
