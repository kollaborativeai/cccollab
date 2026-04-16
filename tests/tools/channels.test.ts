import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createChannelTools, handleChannelTool, type ChannelToolDeps } from '../../src/tools/channels.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

function createMockDeps(): ChannelToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    webClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
      conversations: {
        history: vi.fn().mockResolvedValue({
          ok: true, messages: [{ text: 'Recent msg 1', ts: '200.100' }, { text: 'Recent msg 2', ts: '200.050' }],
        }),
      },
    } as never,
    subscriptionManager: {
      join: vi.fn().mockResolvedValue({ channelId: 'C123', alreadySubscribed: false }),
      leave: vi.fn(),
      getSubscriptions: vi.fn().mockReturnValue(['C123', 'C456']),
      getChannelName: vi.fn((id: string) => ({ C123: 'team-alpha-collab', C456: 'team-beta-collab' })[id]),
      resolveChannelId: vi.fn().mockResolvedValue('C123'),
    } as never,
    context: new ActiveContext(),
  }
}

describe('Channel Tools', () => {
  let deps: ChannelToolDeps
  beforeEach(() => { deps = createMockDeps() })

  it('returns 3 tool definitions', () => {
    expect(createChannelTools()).toHaveLength(3)
  })

  it('createChannelTools has correct tool names', () => {
    const names = createChannelTools().map((t) => t.name)
    expect(names).toEqual(['join_channel', 'leave_channel', 'list_channels'])
  })

  describe('join_channel', () => {
    it('joins and sets active context', async () => {
      const result = await handleChannelTool('join_channel', { channel: 'team-alpha-collab' }, deps)
      expect(deps.subscriptionManager.join).toHaveBeenCalledWith('team-alpha-collab')
      expect(deps.context.hasChannel()).toBe(true)
      expect(deps.context.getChannelId()).toBe('C123')
      expect(deps.context.getChannelName()).toBe('team-alpha-collab')
      expect(result).toContain('Joined #team-alpha-collab')
      expect(result).toContain('active channel')
    })

    it('announces presence to channel', async () => {
      await handleChannelTool('join_channel', { channel: 'team-alpha-collab' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: expect.stringContaining('joined the channel'),
      })
    })

    it('returns history when read_history is true', async () => {
      const result = await handleChannelTool('join_channel', { channel: 'team-alpha-collab', read_history: true }, deps)
      expect(deps.webClient.conversations.history).toHaveBeenCalled()
      expect(result).toContain('Recent msg 1')
    })

    it('skips history when read_history is false', async () => {
      await handleChannelTool('join_channel', { channel: 'team-alpha-collab', read_history: false }, deps)
      expect(deps.webClient.conversations.history).not.toHaveBeenCalled()
    })

    it('notes when already subscribed', async () => {
      ;(deps.subscriptionManager.join as ReturnType<typeof vi.fn>).mockResolvedValue({ channelId: 'C123', alreadySubscribed: true })
      const result = await handleChannelTool('join_channel', { channel: 'team-alpha-collab' }, deps)
      expect(result).toContain('was already subscribed')
    })
  })

  describe('leave_channel', () => {
    it('leaves active channel and clears context', async () => {
      deps.context.setChannel('C123', 'team-alpha-collab')
      const result = await handleChannelTool('leave_channel', {}, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalled()
      expect(deps.subscriptionManager.leave).toHaveBeenCalledWith('C123')
      expect(deps.context.hasChannel()).toBe(false)
      expect(result).toContain('#team-alpha-collab')
    })

    it('leaves a specified channel', async () => {
      deps.context.setChannel('C123', 'team-alpha-collab')
      await handleChannelTool('leave_channel', { channel: 'team-alpha-collab' }, deps)
      expect(deps.subscriptionManager.resolveChannelId).toHaveBeenCalledWith('team-alpha-collab')
      expect(deps.subscriptionManager.leave).toHaveBeenCalledWith('C123')
    })

    it('throws when no active channel and no channel specified', async () => {
      await expect(handleChannelTool('leave_channel', {}, deps)).rejects.toThrow('No active channel')
    })
  })

  describe('list_channels', () => {
    it('lists subscribed channels', async () => {
      const result = await handleChannelTool('list_channels', {}, deps)
      expect(result).toContain('team-alpha-collab')
      expect(result).toContain('team-beta-collab')
    })

    it('marks active channel', async () => {
      deps.context.setChannel('C123', 'team-alpha-collab')
      const result = await handleChannelTool('list_channels', {}, deps)
      expect(result).toContain('(active)')
      expect(result).toContain('team-alpha-collab')
    })

    it('returns empty message when no subscriptions', async () => {
      ;(deps.subscriptionManager.getSubscriptions as ReturnType<typeof vi.fn>).mockReturnValue([])
      const result = await handleChannelTool('list_channels', {}, deps)
      expect(result).toBe('No subscribed channels.')
    })
  })

  it('throws on unknown tool', async () => {
    await expect(handleChannelTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown channel tool')
  })
})
