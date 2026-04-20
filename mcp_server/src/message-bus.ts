import { EventEmitter } from 'node:events'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { ParsedMessage } from './types.js'

export class MessageBus extends EventEmitter {
  private readonly mcp: Server

  constructor(mcp: Server) {
    super()
    this.mcp = mcp
  }

  async push(msg: ParsedMessage): Promise<void> {
    const meta: Record<string, string> = {
      sender: msg.sender,
      channel: msg.channelName ?? msg.channel,
      channel_id: msg.channel,
      ts: msg.ts,
    }
    if (msg.threadTs) {
      meta.thread_ts = msg.threadTs
    }

    await this.mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: msg.text, meta },
    })

    this.emit(`channel:${msg.channel}`, msg)

    if (msg.threadTs) {
      this.emit(`thread:${msg.threadTs}`, msg)
    }
  }
}
