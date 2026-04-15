import { execFileSync } from 'node:child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { WebClient } from '@slack/web-api'
import { SocketModeClient } from '@slack/socket-mode'
import { loadConfig } from './config.js'
import { SessionManager } from './session.js'
import { SubscriptionManager } from './subscriptions.js'
import { MessageBus } from './message-bus.js'
import { SocketModeListener } from './socket-listener.js'
import { createSessionTools, handleSessionTool } from './tools/session.js'
import { createChannelTools, handleChannelTool } from './tools/channels.js'
import { createConversationTools, handleConversationTool } from './tools/conversations.js'

async function main() {
  const config = loadConfig()

  const webClient = new WebClient(config.slackBotToken)
  const socketModeClient = new SocketModeClient({ appToken: config.slackAppToken })

  const authResult = await webClient.auth.test()
  const botUserId = authResult.user_id ?? ''

  // Detect worktree name
  let worktreeName: string | undefined
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    })
    const worktrees = output.split('\n\n').filter(Boolean)
    if (worktrees.length > 1) {
      const cwd = process.cwd()
      const mainWorktreeLine = worktrees[0]!.split('\n')[0]!
      const mainWorktree = mainWorktreeLine.replace('worktree ', '')
      if (cwd !== mainWorktree) {
        const mainName = mainWorktree.split('/').pop() ?? ''
        const cwdName = cwd.split('/').pop() ?? ''
        if (cwdName.startsWith(mainName + '-')) {
          worktreeName = cwdName.slice(mainName.length + 1)
        }
      }
    }
  } catch {
    // Not in a git repo - fine
  }

  const session = new SessionManager({ username: config.username, cwd: process.cwd(), worktreeName })
  const subscriptions = new SubscriptionManager(webClient)
  const registryChannelId = await subscriptions.resolveChannelId(config.registryChannel)

  const mcp = new Server(
    { name: 'slack-collab', version: '1.0.0' },
    {
      capabilities: {
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions: [
        'You are connected to the Slack Claude Bridge. Messages from other Claude Code sessions and human team members arrive as <channel source="slack-collab" ...> tags.',
        '',
        'When you receive a channel event:',
        '- Read the sender, channel, and thread_ts attributes to understand context',
        '- Use reply_in_conversation to respond in the same thread',
        '- Use start_conversation to begin a new discussion',
        '',
        'Available tools: announce_session, list_sessions, set_status, subscribe_channel, unsubscribe_channel, list_subscriptions, start_conversation, join_conversation, reply_in_conversation, list_conversations, resolve_conversation',
        '',
        'Start by calling announce_session with your role, then subscribe_channel to join your team channel.',
      ].join('\n'),
    }
  )

  const messageBus = new MessageBus(mcp)
  const socketListener = new SocketModeListener({
    socketClient: socketModeClient, messageBus, subscriptionManager: subscriptions,
    sessionManager: session, botUserId,
  })

  const allTools = [...createSessionTools(), ...createChannelTools(), ...createConversationTools()]

  const sessionToolNames = new Set(['announce_session', 'list_sessions', 'set_status'])
  const channelToolNames = new Set(['subscribe_channel', 'unsubscribe_channel', 'list_subscriptions'])
  const conversationToolNames = new Set([
    'start_conversation', 'join_conversation', 'reply_in_conversation', 'list_conversations', 'resolve_conversation',
  ])

  const sessionDeps = { session, webClient, registryChannelId }
  const channelDeps = { session, webClient, subscriptionManager: subscriptions }
  const conversationDeps = { session, webClient, subscriptionManager: subscriptions }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const toolArgs = (args ?? {}) as Record<string, unknown>
    try {
      let result: string
      if (sessionToolNames.has(name)) result = await handleSessionTool(name, toolArgs, sessionDeps)
      else if (channelToolNames.has(name)) result = await handleChannelTool(name, toolArgs, channelDeps)
      else if (conversationToolNames.has(name)) result = await handleConversationTool(name, toolArgs, conversationDeps)
      else throw new Error(`Unknown tool: ${name}`)
      return { content: [{ type: 'text' as const, text: result }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
    }
  })

  await mcp.connect(new StdioServerTransport())
  await socketListener.start()

  console.error(`[slack-collab] Session "${session.sessionName}" connected`)

  const cleanup = () => { console.error('[slack-collab] Shutting down...'); process.exit(0) }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

main().catch((err) => { console.error('[slack-collab] Fatal error:', err); process.exit(1) })
