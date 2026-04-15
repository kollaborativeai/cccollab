import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createChannelTools, handleChannelTool, type ChannelToolDeps } from '../../src/tools/channels.js'
import { SessionManager } from '../../src/session.js'

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
  }
}

describe('Channel Tools', () => {
  let deps: ChannelToolDeps
  beforeEach(() => { deps = createMockDeps() })

  it('returns 3 tool definitions', () => {
    expect(createChannelTools()).toHaveLength(3)
  })

  it('subscribe_channel joins and announces', async () => {
    const result = await handleChannelTool('subscribe_channel', { channel: 'team-alpha-collab' }, deps)
    expect(deps.subscriptionManager.join).toHaveBeenCalledWith('team-alpha-collab')
    expect(result).toContain('Subscribed')
  })

  it('subscribe_channel returns history when read_history true', async () => {
    const result = await handleChannelTool('subscribe_channel', { channel: 'team-alpha-collab', read_history: true }, deps)
    expect(deps.webClient.conversations.history).toHaveBeenCalled()
    expect(result).toContain('Recent msg 1')
  })

  it('subscribe_channel skips history when read_history false', async () => {
    await handleChannelTool('subscribe_channel', { channel: 'team-alpha-collab', read_history: false }, deps)
    expect(deps.webClient.conversations.history).not.toHaveBeenCalled()
  })

  it('unsubscribe_channel leaves and posts departure', async () => {
    await handleChannelTool('unsubscribe_channel', { channel: 'team-alpha-collab' }, deps)
    expect(deps.webClient.chat.postMessage).toHaveBeenCalled()
    expect(deps.subscriptionManager.leave).toHaveBeenCalledWith('C123')
  })

  it('unsubscribe_channel skips departure when post_departure false', async () => {
    await handleChannelTool('unsubscribe_channel', { channel: 'team-alpha-collab', post_departure: false }, deps)
    expect(deps.webClient.chat.postMessage).not.toHaveBeenCalled()
    expect(deps.subscriptionManager.leave).toHaveBeenCalledWith('C123')
  })

  it('list_subscriptions returns channel names', async () => {
    const result = await handleChannelTool('list_subscriptions', {}, deps)
    expect(result).toContain('team-alpha-collab')
    expect(result).toContain('team-beta-collab')
  })
})
