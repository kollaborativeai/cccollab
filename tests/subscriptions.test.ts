import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubscriptionManager } from '../src/subscriptions.js'

function createMockWebClient() {
  return {
    conversations: {
      join: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'C123' } }),
      list: vi.fn().mockResolvedValue({
        ok: true,
        channels: [
          { id: 'C123', name: 'team-alpha-collab' },
          { id: 'C456', name: 'team-beta-collab' },
        ],
      }),
    },
  }
}

describe('SubscriptionManager', () => {
  let sm: SubscriptionManager
  let mockClient: ReturnType<typeof createMockWebClient>

  beforeEach(() => {
    mockClient = createMockWebClient()
    sm = new SubscriptionManager(mockClient as never)
  })

  describe('join', () => {
    it('joins a channel by name and adds to local subscriptions', async () => {
      const result = await sm.join('team-alpha-collab')
      expect(result.channelId).toBe('C123')
      expect(result.alreadySubscribed).toBe(false)
      expect(sm.isSubscribed('C123')).toBe(true)
    })

    it('is idempotent - second join returns alreadySubscribed true', async () => {
      await sm.join('team-alpha-collab')
      const result = await sm.join('team-alpha-collab')
      expect(result.alreadySubscribed).toBe(true)
    })

    it('caches channel name to ID lookups', async () => {
      await sm.join('team-alpha-collab')
      await sm.join('team-alpha-collab')
      expect(mockClient.conversations.list).toHaveBeenCalledTimes(1)
    })

    it('throws when channel is not found', async () => {
      await expect(sm.join('nonexistent-channel')).rejects.toThrow('Channel "nonexistent-channel" not found')
    })
  })

  describe('leave', () => {
    it('removes channel from local subscriptions', async () => {
      await sm.join('team-alpha-collab')
      sm.leave('C123')
      expect(sm.isSubscribed('C123')).toBe(false)
    })

    it('does not call Slack API on leave', async () => {
      await sm.join('team-alpha-collab')
      mockClient.conversations.join.mockClear()
      sm.leave('C123')
      expect(mockClient.conversations.join).not.toHaveBeenCalled()
    })

    it('is safe to leave a channel not subscribed to', () => {
      expect(() => sm.leave('C999')).not.toThrow()
    })
  })

  describe('isSubscribed', () => {
    it('returns false for channels not subscribed to', () => {
      expect(sm.isSubscribed('C999')).toBe(false)
    })

    it('returns true after join', async () => {
      await sm.join('team-alpha-collab')
      expect(sm.isSubscribed('C123')).toBe(true)
    })

    it('returns false after leave', async () => {
      await sm.join('team-alpha-collab')
      sm.leave('C123')
      expect(sm.isSubscribed('C123')).toBe(false)
    })
  })

  describe('getSubscriptions', () => {
    it('returns empty array when no subscriptions', () => {
      expect(sm.getSubscriptions()).toEqual([])
    })

    it('returns all subscribed channel IDs', async () => {
      await sm.join('team-alpha-collab')
      await sm.join('team-beta-collab')
      const subs = sm.getSubscriptions()
      expect(subs).toContain('C123')
      expect(subs).toContain('C456')
      expect(subs).toHaveLength(2)
    })
  })

  describe('resolveChannelId', () => {
    it('resolves channel name to ID', async () => {
      expect(await sm.resolveChannelId('team-alpha-collab')).toBe('C123')
    })

    it('returns cached ID on subsequent calls', async () => {
      await sm.resolveChannelId('team-alpha-collab')
      await sm.resolveChannelId('team-alpha-collab')
      expect(mockClient.conversations.list).toHaveBeenCalledTimes(1)
    })

    it('throws for unknown channel', async () => {
      await expect(sm.resolveChannelId('nonexistent')).rejects.toThrow('Channel "nonexistent" not found')
    })
  })
})
