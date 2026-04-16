import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createChannelTools, handleChannelTool, type ChannelToolDeps } from '../../src/tools/channels.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

function createMockDeps(): ChannelToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    webClient: {
      conversations: {
        history: vi.fn().mockResolvedValue({
          ok: true, messages: [{ text: 'Recent msg 1', ts: '200.100' }, { text: 'Recent msg 2', ts: '200.050' }],
        }),
        list: vi.fn().mockResolvedValue({
          ok: true,
          channels: [
            { id: 'C123', name: 'team-alpha-collab', is_private: false, is_member: true },
            { id: 'C456', name: 'team-beta-collab', is_private: false, is_member: true },
            { id: 'C789', name: 'secret-channel', is_private: true, is_member: true },
          ],
          response_metadata: {},
        }),
      },
    } as never,
    postClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
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

  describe('join_channel', () => {
    it('joins and sets active context', async () => {
      const result = await handleChannelTool('join_channel', { channel: 'team-alpha-collab' }, deps)
      expect(deps.subscriptionManager.join).toHaveBeenCalledWith('team-alpha-collab')
      expect(deps.context.hasChannel()).toBe(true)
      expect(deps.context.getChannelId()).toBe('C123')
      expect(result).toContain('Joined #team-alpha-collab')
    })

    it('does not post a join announcement', async () => {
      await handleChannelTool('join_channel', { channel: 'team-alpha-collab' }, deps)
      expect(deps.postClient.chat.postMessage).not.toHaveBeenCalled()
    })

    it('leaves previous channel when joining a new one', async () => {
      deps.context.setChannel('C999', 'old-channel')
      await handleChannelTool('join_channel', { channel: 'team-alpha-collab' }, deps)
      expect(deps.subscriptionManager.leave).toHaveBeenCalledWith('C999')
      expect(deps.context.getChannelId()).toBe('C123')
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
  })

  describe('leave_channel', () => {
    it('leaves active channel and clears context', async () => {
      deps.context.setChannel('C123', 'team-alpha-collab')
      const result = await handleChannelTool('leave_channel', {}, deps)
      expect(deps.subscriptionManager.leave).toHaveBeenCalledWith('C123')
      expect(deps.context.hasChannel()).toBe(false)
      expect(result).toContain('#team-alpha-collab')
    })

    it('throws when no active channel', async () => {
      await expect(handleChannelTool('leave_channel', {}, deps)).rejects.toThrow('No active channel')
    })
  })

  describe('list_channels', () => {
    it('lists all available channels', async () => {
      const result = await handleChannelTool('list_channels', {}, deps)
      expect(result).toContain('secret-channel')
      expect(result).toContain('(private)')
      expect(result).toContain('team-alpha-collab')
      expect(result).toContain('team-beta-collab')
    })

    it('marks active channel', async () => {
      deps.context.setChannel('C123', 'team-alpha-collab')
      const result = await handleChannelTool('list_channels', {}, deps)
      expect(result).toContain('<-- active')
    })

    it('returns empty message when no channels', async () => {
      ;(deps.webClient.conversations.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true, channels: [], response_metadata: {},
      })
      const result = await handleChannelTool('list_channels', {}, deps)
      expect(result).toContain('No channels found')
    })
  })
})
