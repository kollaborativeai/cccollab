import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createConversationTools, handleConversationTool, type ConversationToolDeps } from '../../src/tools/conversations.js'
import { SessionManager } from '../../src/session.js'

function createMockDeps(): ConversationToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    webClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '300.100' }) },
      conversations: {
        replies: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { text: '*[alice-frontend]*: started this thread', ts: '300.100', user: 'U1' },
            { text: '*[bob-backend]*: I can help', ts: '300.200', user: 'U2' },
          ],
        }),
        history: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { text: ':large_green_circle: TOPIC: Auth refactor | *[alice-frontend]*', ts: '300.100', reply_count: 5 },
            { text: ':white_check_mark: TOPIC: Setup CI | *[bob-backend]*', ts: '200.100', reply_count: 3 },
            { text: 'Random non-topic message', ts: '100.100' },
          ],
        }),
      },
    } as never,
    subscriptionManager: { resolveChannelId: vi.fn().mockResolvedValue('C123') } as never,
  }
}

describe('Conversation Tools', () => {
  let deps: ConversationToolDeps
  beforeEach(() => { deps = createMockDeps() })

  it('returns 5 tool definitions', () => {
    expect(createConversationTools()).toHaveLength(5)
  })

  it('start_conversation posts topic and returns thread_ts', async () => {
    const result = await handleConversationTool('start_conversation', { channel: 'team-alpha-collab', topic: 'Auth refactor' }, deps)
    expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({ channel: 'C123', text: expect.stringContaining('Auth refactor') })
    expect(result).toContain('300.100')
  })

  it('join_conversation fetches history and announces', async () => {
    const result = await handleConversationTool('join_conversation', { channel: 'team-alpha-collab', thread_ts: '300.100' }, deps)
    expect(deps.webClient.conversations.replies).toHaveBeenCalledWith({ channel: 'C123', ts: '300.100' })
    expect(result).toContain('alice-frontend')
    expect(result).toContain('bob-backend')
  })

  it('reply_in_conversation posts formatted reply', async () => {
    await handleConversationTool('reply_in_conversation', { channel: 'team-alpha-collab', thread_ts: '300.100', text: 'Here is my review' }, deps)
    expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123', thread_ts: '300.100', text: '*[stefan-dispatcher]*: Here is my review',
    })
  })

  it('list_conversations returns active topics', async () => {
    const result = await handleConversationTool('list_conversations', { channel: 'team-alpha-collab' }, deps)
    expect(result).toContain('Auth refactor')
    expect(result).not.toContain('Setup CI')
  })

  it('list_conversations includes resolved when requested', async () => {
    const result = await handleConversationTool('list_conversations', { channel: 'team-alpha-collab', include_resolved: true }, deps)
    expect(result).toContain('Auth refactor')
    expect(result).toContain('Setup CI')
  })

  it('resolve_conversation posts summary', async () => {
    await handleConversationTool('resolve_conversation', { channel: 'team-alpha-collab', thread_ts: '300.100', summary: 'Agreed on JWT approach' }, deps)
    expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123', thread_ts: '300.100', text: expect.stringContaining('RESOLVED'),
    })
  })
})
