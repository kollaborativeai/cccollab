# Slack Claude Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that enables Claude Code sessions to collaborate in real-time via Slack channels and threads, using the Channel protocol for push-based inbound delivery and MCP tools for outbound actions.

**Architecture:** Single Node.js process per developer machine. Socket Mode WebSocket receives Slack events, SubscriptionManager filters locally, MessageBus routes and pushes to Claude via Channel notifications. MCP tools handle all outbound actions (sending messages, managing subscriptions, querying state). No polling, no wait tools.

**Tech Stack:** Node.js + TypeScript (ES Modules, ES2022), @modelcontextprotocol/sdk, @slack/web-api, @slack/socket-mode, zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-14-slack-claude-bridge-design.md`

**Jira Epic:** IRD-46

---

## File Structure

```
src/
  server.ts              # Entry point - MCP server, tool registration, wiring
  config.ts              # Environment variable validation with zod
  types.ts               # Shared types and interfaces
  session.ts             # SessionManager - identity, fmt/parse, registry
  subscriptions.ts       # SubscriptionManager - join/leave, local filtering
  message-bus.ts         # EventEmitter pass-through, Channel notification bridge
  socket-listener.ts     # Socket Mode connection, event routing to MessageBus
  tools/
    session.ts           # announce_session, list_sessions, set_status
    channels.ts          # subscribe_channel, unsubscribe_channel, list_subscriptions
    conversations.ts     # start/join/reply/list/resolve_conversation
tests/
  config.test.ts
  session.test.ts
  subscriptions.test.ts
  message-bus.test.ts
  socket-listener.test.ts
  tools/
    session.test.ts
    channels.test.ts
    conversations.test.ts
  integration.test.ts
```

---

### Task 1: Project Scaffolding & Config Validation (IRD-48)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/config.ts`
- Create: `src/types.ts`
- Create: `tests/config.test.ts`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Initialize project and install dependencies**

```bash
cd /Users/stefan/projects/claudecode-slack-collab
yarn init -y
yarn add @modelcontextprotocol/sdk @slack/web-api @slack/socket-mode zod
yarn add -D typescript tsx @types/node vitest
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "lib": ["ES2022"],
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Update package.json scripts and type**

Add to `package.json`:
```json
{
  "type": "module",
  "scripts": {
    "start": "npx tsx src/server.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.env.*
```

- [ ] **Step 6: Write the failing test for config validation**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns valid config when all required env vars are set', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    process.env.SLACK_APP_TOKEN = 'xapp-test-token'
    process.env.USERNAME = 'stefan'

    const config = loadConfig()

    expect(config.slackBotToken).toBe('xoxb-test-token')
    expect(config.slackAppToken).toBe('xapp-test-token')
    expect(config.username).toBe('stefan')
    expect(config.registryChannel).toBe('ai-collab-registry')
  })

  it('throws when SLACK_BOT_TOKEN is missing', () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test-token'
    process.env.USERNAME = 'stefan'

    expect(() => loadConfig()).toThrow('SLACK_BOT_TOKEN')
  })

  it('throws when SLACK_APP_TOKEN is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    process.env.USERNAME = 'stefan'

    expect(() => loadConfig()).toThrow('SLACK_APP_TOKEN')
  })

  it('throws when USERNAME is missing', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    process.env.SLACK_APP_TOKEN = 'xapp-test-token'

    expect(() => loadConfig()).toThrow('USERNAME')
  })

  it('uses defaults for optional env vars', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    process.env.SLACK_APP_TOKEN = 'xapp-test-token'
    process.env.USERNAME = 'stefan'

    const config = loadConfig()

    expect(config.sessionRole).toBeUndefined()
    expect(config.registryChannel).toBe('ai-collab-registry')
  })

  it('respects optional env var overrides', () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    process.env.SLACK_APP_TOKEN = 'xapp-test-token'
    process.env.USERNAME = 'stefan'
    process.env.SESSION_ROLE = 'frontend'
    process.env.REGISTRY_CHANNEL = 'custom-registry'

    const config = loadConfig()

    expect(config.sessionRole).toBe('frontend')
    expect(config.registryChannel).toBe('custom-registry')
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `yarn test tests/config.test.ts`
Expected: FAIL - cannot resolve `../src/config.js`

- [ ] **Step 8: Create src/types.ts**

```ts
export interface Config {
  slackBotToken: string
  slackAppToken: string
  username: string
  sessionRole: string | undefined
  registryChannel: string
}

export interface ParsedMessage {
  sender: string
  text: string
  ts: string
  channel: string
  threadTs: string | undefined
}
```

- [ ] **Step 9: Implement src/config.ts**

```ts
import { z } from 'zod'
import type { Config } from './types.js'

const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, 'SLACK_BOT_TOKEN is required'),
  SLACK_APP_TOKEN: z.string().min(1, 'SLACK_APP_TOKEN is required'),
  USERNAME: z.string().min(1, 'USERNAME is required'),
  SESSION_ROLE: z.string().optional(),
  REGISTRY_CHANNEL: z.string().optional(),
})

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    const errors = result.error.issues.map((i) => i.message).join(', ')
    throw new Error(`Invalid configuration: ${errors}`)
  }

  return {
    slackBotToken: result.data.SLACK_BOT_TOKEN,
    slackAppToken: result.data.SLACK_APP_TOKEN,
    username: result.data.USERNAME,
    sessionRole: result.data.SESSION_ROLE,
    registryChannel: result.data.REGISTRY_CHANNEL ?? 'ai-collab-registry',
  }
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `yarn test tests/config.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 11: Commit**

```bash
git add package.json yarn.lock tsconfig.json vitest.config.ts .gitignore src/config.ts src/types.ts tests/config.test.ts
git commit -m "feat(IRD-48): project scaffolding, config validation, shared types"
```

---

### Task 2: SessionManager - Identity & Message Formatting (IRD-48)

**Files:**
- Create: `src/session.ts`
- Create: `tests/session.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SessionManager } from '../src/session.js'

describe('SessionManager', () => {
  describe('session name derivation', () => {
    it('derives name from username and cwd repo name', () => {
      const sm = new SessionManager({
        username: 'stefan',
        cwd: '/Users/stefan/projects/dispatcher',
      })
      expect(sm.sessionName).toBe('stefan-dispatcher')
    })

    it('includes worktree suffix when present', () => {
      const sm = new SessionManager({
        username: 'stefan',
        cwd: '/Users/stefan/projects/dispatcher-TWO',
        worktreeName: 'TWO',
      })
      expect(sm.sessionName).toBe('stefan-dispatcher-TWO')
    })

    it('falls back to username-unknown when cwd has no parseable name', () => {
      const sm = new SessionManager({ username: 'stefan', cwd: '/' })
      expect(sm.sessionName).toBe('stefan-unknown')
    })

    it('allows name override', () => {
      const sm = new SessionManager({
        username: 'stefan',
        cwd: '/Users/stefan/projects/dispatcher',
      })
      sm.overrideName('stefan-frontend')
      expect(sm.sessionName).toBe('stefan-frontend')
    })
  })

  describe('fmt', () => {
    it('prefixes text with session identity', () => {
      const sm = new SessionManager({
        username: 'stefan',
        cwd: '/Users/stefan/projects/dispatcher',
      })
      expect(sm.fmt('hello world')).toBe('*[stefan-dispatcher]*: hello world')
    })
  })

  describe('parse', () => {
    it('extracts session name and text from formatted message', () => {
      const result = SessionManager.parse('*[stefan-dispatcher]*: hello world')
      expect(result).toEqual({ sender: 'stefan-dispatcher', text: 'hello world' })
    })

    it('handles multiline messages', () => {
      const result = SessionManager.parse('*[bob-backend]*: line one\nline two\nline three')
      expect(result).toEqual({ sender: 'bob-backend', text: 'line one\nline two\nline three' })
    })

    it('returns null for unformatted messages (human messages)', () => {
      expect(SessionManager.parse('just a regular message')).toBeNull()
    })

    it('returns null for empty messages', () => {
      expect(SessionManager.parse('')).toBeNull()
    })
  })

  describe('isSelf', () => {
    it('returns true when sender matches session name', () => {
      const sm = new SessionManager({
        username: 'stefan',
        cwd: '/Users/stefan/projects/dispatcher',
      })
      expect(sm.isSelf('stefan-dispatcher')).toBe(true)
    })

    it('returns false for different session names', () => {
      const sm = new SessionManager({
        username: 'stefan',
        cwd: '/Users/stefan/projects/dispatcher',
      })
      expect(sm.isSelf('carlos-backend')).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tests/session.test.ts`
Expected: FAIL - cannot resolve `../src/session.js`

- [ ] **Step 3: Implement src/session.ts**

```ts
import path from 'node:path'

const SESSION_PREFIX_PATTERN = /^\*\[(.+?)\]\*:\s*([\s\S]*)$/

interface SessionManagerOptions {
  username: string
  cwd: string
  worktreeName?: string
}

export class SessionManager {
  private name: string
  private readonly username: string

  constructor(options: SessionManagerOptions) {
    this.username = options.username
    this.name = this.deriveName(options)
  }

  get sessionName(): string {
    return this.name
  }

  overrideName(newName: string): void {
    this.name = newName
  }

  fmt(text: string): string {
    return `*[${this.name}]*: ${text}`
  }

  isSelf(senderName: string): boolean {
    return senderName === this.name
  }

  static parse(text: string): { sender: string; text: string } | null {
    const match = SESSION_PREFIX_PATTERN.exec(text)
    if (!match) return null
    return { sender: match[1], text: match[2] }
  }

  private deriveName(options: SessionManagerOptions): string {
    const dirName = path.basename(options.cwd)
    if (!dirName || dirName === '/') {
      return `${options.username}-unknown`
    }

    let repoName = dirName
    if (options.worktreeName) {
      const suffix = `-${options.worktreeName}`
      if (repoName.endsWith(suffix)) {
        repoName = repoName.slice(0, -suffix.length)
      }
      return `${options.username}-${repoName}-${options.worktreeName}`
    }

    return `${options.username}-${repoName}`
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tests/session.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session.test.ts
git commit -m "feat(IRD-48): SessionManager with identity derivation and message formatting"
```

---

### Task 3: SubscriptionManager (IRD-50)

**Files:**
- Create: `src/subscriptions.ts`
- Create: `tests/subscriptions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/subscriptions.test.ts`:

```ts
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
      await expect(sm.join('nonexistent-channel')).rejects.toThrow(
        'Channel "nonexistent-channel" not found'
      )
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
      await expect(sm.resolveChannelId('nonexistent')).rejects.toThrow(
        'Channel "nonexistent" not found'
      )
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tests/subscriptions.test.ts`
Expected: FAIL - cannot resolve `../src/subscriptions.js`

- [ ] **Step 3: Implement src/subscriptions.ts**

```ts
import type { WebClient } from '@slack/web-api'

interface JoinResult {
  channelId: string
  alreadySubscribed: boolean
}

export class SubscriptionManager {
  private readonly subscriptions = new Set<string>()
  private readonly channelCache = new Map<string, string>()
  private readonly client: WebClient
  private channelListLoaded = false

  constructor(client: WebClient) {
    this.client = client
  }

  async join(channelName: string): Promise<JoinResult> {
    const channelId = await this.resolveChannelId(channelName)
    const alreadySubscribed = this.subscriptions.has(channelId)

    await this.client.conversations.join({ channel: channelId })
    this.subscriptions.add(channelId)

    return { channelId, alreadySubscribed }
  }

  leave(channelId: string): void {
    this.subscriptions.delete(channelId)
  }

  isSubscribed(channelId: string): boolean {
    return this.subscriptions.has(channelId)
  }

  getSubscriptions(): string[] {
    return [...this.subscriptions]
  }

  async resolveChannelId(channelName: string): Promise<string> {
    const cached = this.channelCache.get(channelName)
    if (cached) return cached

    if (!this.channelListLoaded) {
      await this.loadChannelList()
    }

    const id = this.channelCache.get(channelName)
    if (!id) {
      throw new Error(
        `Channel "${channelName}" not found. Make sure the bot is invited to the channel.`
      )
    }

    return id
  }

  getChannelName(channelId: string): string | undefined {
    for (const [name, id] of this.channelCache) {
      if (id === channelId) return name
    }
    return undefined
  }

  private async loadChannelList(): Promise<void> {
    const result = await this.client.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
      limit: 1000,
    })

    for (const channel of result.channels ?? []) {
      if (channel.id && channel.name) {
        this.channelCache.set(channel.name, channel.id)
      }
    }

    this.channelListLoaded = true
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tests/subscriptions.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/subscriptions.ts tests/subscriptions.test.ts
git commit -m "feat(IRD-50): SubscriptionManager with local filtering and channel ID cache"
```

---

### Task 4: MessageBus & Channel Notification Bridge (IRD-49, IRD-54)

**Files:**
- Create: `src/message-bus.ts`
- Create: `tests/message-bus.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/message-bus.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageBus } from '../src/message-bus.js'
import type { ParsedMessage } from '../src/types.js'

function createMockMcp() {
  return { notification: vi.fn().mockResolvedValue(undefined) }
}

function createMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    sender: 'stefan-dispatcher',
    text: 'hello world',
    ts: '1234567890.123456',
    channel: 'C123',
    threadTs: undefined,
    ...overrides,
  }
}

describe('MessageBus', () => {
  let bus: MessageBus
  let mockMcp: ReturnType<typeof createMockMcp>

  beforeEach(() => {
    mockMcp = createMockMcp()
    bus = new MessageBus(mockMcp as never)
  })

  describe('push', () => {
    it('pushes channel notification to Claude', async () => {
      await bus.push(createMessage())
      expect(mockMcp.notification).toHaveBeenCalledWith({
        method: 'notifications/claude/channel',
        params: {
          content: 'hello world',
          meta: { sender: 'stefan-dispatcher', channel: 'C123', ts: '1234567890.123456' },
        },
      })
    })

    it('includes thread_ts in meta when present', async () => {
      await bus.push(createMessage({ threadTs: '1234567890.000001' }))
      expect(mockMcp.notification).toHaveBeenCalledWith({
        method: 'notifications/claude/channel',
        params: {
          content: 'hello world',
          meta: {
            sender: 'stefan-dispatcher',
            channel: 'C123',
            ts: '1234567890.123456',
            thread_ts: '1234567890.000001',
          },
        },
      })
    })

    it('emits on channel key', async () => {
      const listener = vi.fn()
      bus.on('channel:C123', listener)
      await bus.push(createMessage())
      expect(listener).toHaveBeenCalledWith(createMessage())
    })

    it('emits on thread key when threadTs present', async () => {
      const msg = createMessage({ threadTs: '1234567890.000001' })
      const channelListener = vi.fn()
      const threadListener = vi.fn()
      bus.on('channel:C123', channelListener)
      bus.on('thread:1234567890.000001', threadListener)
      await bus.push(msg)
      expect(channelListener).toHaveBeenCalledWith(msg)
      expect(threadListener).toHaveBeenCalledWith(msg)
    })

    it('does not emit on thread key when threadTs is undefined', async () => {
      const threadListener = vi.fn()
      bus.on('thread:undefined', threadListener)
      await bus.push(createMessage({ threadTs: undefined }))
      expect(threadListener).not.toHaveBeenCalled()
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tests/message-bus.test.ts`
Expected: FAIL - cannot resolve `../src/message-bus.js`

- [ ] **Step 3: Implement src/message-bus.ts**

```ts
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
      channel: msg.channel,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tests/message-bus.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/message-bus.ts tests/message-bus.test.ts
git commit -m "feat(IRD-49,IRD-54): MessageBus with Channel notification bridge"
```

---

### Task 5: SocketModeListener (IRD-51)

**Files:**
- Create: `src/socket-listener.ts`
- Create: `tests/socket-listener.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/socket-listener.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SocketModeListener } from '../src/socket-listener.js'
import { SessionManager } from '../src/session.js'

function createMockSocketModeClient() {
  const handlers = new Map<string, Function>()
  return {
    on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler) }),
    start: vi.fn().mockResolvedValue(undefined),
    _trigger: (event: string, payload: unknown) => {
      const handler = handlers.get(event)
      if (handler) handler(payload)
    },
  }
}

function createMockMessageBus() {
  return { push: vi.fn().mockResolvedValue(undefined) }
}

function createMockSubscriptionManager() {
  const subscribed = new Set<string>(['C123'])
  return {
    isSubscribed: vi.fn((id: string) => subscribed.has(id)),
    getChannelName: vi.fn((id: string) => (id === 'C123' ? 'team-alpha-collab' : undefined)),
  }
}

describe('SocketModeListener', () => {
  let listener: SocketModeListener
  let mockSocket: ReturnType<typeof createMockSocketModeClient>
  let mockBus: ReturnType<typeof createMockMessageBus>
  let mockSubs: ReturnType<typeof createMockSubscriptionManager>

  beforeEach(() => {
    mockSocket = createMockSocketModeClient()
    mockBus = createMockMessageBus()
    mockSubs = createMockSubscriptionManager()
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })

    listener = new SocketModeListener({
      socketClient: mockSocket as never,
      messageBus: mockBus as never,
      subscriptionManager: mockSubs as never,
      sessionManager: session,
      botUserId: 'U_BOT',
    })
  })

  it('registers message handler on construction', () => {
    expect(mockSocket.on).toHaveBeenCalledWith('message', expect.any(Function))
  })

  it('starts the socket mode client', async () => {
    await listener.start()
    expect(mockSocket.start).toHaveBeenCalled()
  })

  it('routes a subscribed channel message to the message bus', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C123', text: '*[carlos-backend]*: need help', ts: '111.222', user: 'U_CARLOS' },
    })
    expect(mockBus.push).toHaveBeenCalledWith({
      sender: 'carlos-backend', text: 'need help', ts: '111.222', channel: 'C123', threadTs: undefined,
    })
  })

  it('includes threadTs for thread replies', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C123', text: '*[carlos-backend]*: fix', ts: '111.333', thread_ts: '111.222', user: 'U_CARLOS' },
    })
    expect(mockBus.push).toHaveBeenCalledWith(expect.objectContaining({ threadTs: '111.222' }))
  })

  it('drops messages from unsubscribed channels', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C999', text: '*[alice]*: hello', ts: '111.444', user: 'U_ALICE' },
    })
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops self-messages by bot user ID', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C123', text: '*[stefan-dispatcher]*: my msg', ts: '111.555', user: 'U_BOT' },
    })
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('drops messages with subtypes', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', subtype: 'channel_join', channel: 'C123', text: 'joined', ts: '111.666', user: 'U_SOMEONE' },
    })
    expect(mockBus.push).not.toHaveBeenCalled()
  })

  it('handles human messages (no session prefix)', () => {
    mockSocket._trigger('message', {
      ack: vi.fn(),
      event: { type: 'message', channel: 'C123', text: 'hey team status?', ts: '111.777', user: 'U_HUMAN' },
    })
    expect(mockBus.push).toHaveBeenCalledWith({
      sender: 'human:U_HUMAN', text: 'hey team status?', ts: '111.777', channel: 'C123', threadTs: undefined,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tests/socket-listener.test.ts`
Expected: FAIL - cannot resolve `../src/socket-listener.js`

- [ ] **Step 3: Implement src/socket-listener.ts**

```ts
import type { SocketModeClient } from '@slack/socket-mode'
import type { MessageBus } from './message-bus.js'
import type { SubscriptionManager } from './subscriptions.js'
import { SessionManager } from './session.js'
import type { ParsedMessage } from './types.js'

interface SocketModeListenerOptions {
  socketClient: SocketModeClient
  messageBus: MessageBus
  subscriptionManager: SubscriptionManager
  sessionManager: SessionManager
  botUserId: string
}

const IGNORED_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'channel_archive', 'channel_unarchive',
  'bot_message', 'me_message', 'message_changed', 'message_deleted', 'thread_broadcast',
])

export class SocketModeListener {
  private readonly socket: SocketModeClient
  private readonly bus: MessageBus
  private readonly subs: SubscriptionManager
  private readonly session: SessionManager
  private readonly botUserId: string

  constructor(options: SocketModeListenerOptions) {
    this.socket = options.socketClient
    this.bus = options.messageBus
    this.subs = options.subscriptionManager
    this.session = options.sessionManager
    this.botUserId = options.botUserId

    this.socket.on('message', (payload) => this.handleMessage(payload))
  }

  async start(): Promise<void> {
    await this.socket.start()
  }

  private handleMessage(payload: {
    ack: () => void
    event: {
      type: string; subtype?: string; channel: string
      text?: string; ts: string; thread_ts?: string; user?: string
    }
  }): void {
    payload.ack()
    const { event } = payload

    if (event.subtype && IGNORED_SUBTYPES.has(event.subtype)) return
    if (!this.subs.isSubscribed(event.channel)) return
    if (event.user === this.botUserId) return

    const text = event.text ?? ''
    const parsed = SessionManager.parse(text)

    let sender: string
    let messageText: string

    if (parsed) {
      if (this.session.isSelf(parsed.sender)) return
      sender = parsed.sender
      messageText = parsed.text
    } else {
      sender = `human:${event.user ?? 'unknown'}`
      messageText = text
    }

    const msg: ParsedMessage = {
      sender, text: messageText, ts: event.ts, channel: event.channel, threadTs: event.thread_ts,
    }

    this.bus.push(msg).catch((err) => {
      console.error('Failed to push message to bus:', err)
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tests/socket-listener.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/socket-listener.ts tests/socket-listener.test.ts
git commit -m "feat(IRD-51): SocketModeListener with subscription filtering and dual routing"
```

---

### Task 6: MCP Tools - Session Management (IRD-52)

**Files:**
- Create: `src/tools/session.ts`
- Create: `tests/tools/session.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSessionTools, handleSessionTool, type SessionToolDeps } from '../../src/tools/session.js'
import { SessionManager } from '../../src/session.js'

function createMockDeps(): SessionToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    webClient: {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '100.200' }) },
      conversations: {
        history: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { text: ':robot_face: *[carlos-backend]* online | Role: backend | Status: Working on API', ts: '100.100' },
            { text: ':robot_face: *[stefan-dispatcher]* online | Role: fullstack | Status: Starting up', ts: '100.050' },
            { text: ':robot_face: *[carlos-backend]* online | Role: backend | Status: Idle', ts: '99.999' },
          ],
        }),
      },
    } as never,
    registryChannelId: 'C_REGISTRY',
  }
}

describe('Session Tools', () => {
  describe('createSessionTools', () => {
    it('returns 3 tool definitions', () => {
      const tools = createSessionTools()
      expect(tools).toHaveLength(3)
      expect(tools.map((t) => t.name)).toEqual(['announce_session', 'list_sessions', 'set_status'])
    })
  })

  describe('handleSessionTool', () => {
    let deps: SessionToolDeps

    beforeEach(() => { deps = createMockDeps() })

    it('announce_session posts to registry channel', async () => {
      const result = await handleSessionTool('announce_session', { role: 'fullstack' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan-dispatcher]* online | Role: fullstack',
      })
      expect(result).toContain('stefan-dispatcher')
    })

    it('announce_session includes status when provided', async () => {
      await handleSessionTool('announce_session', { role: 'fullstack', status: 'Working on auth' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan-dispatcher]* online | Role: fullstack | Status: Working on auth',
      })
    })

    it('announce_session allows name override', async () => {
      await handleSessionTool('announce_session', { role: 'frontend', name_override: 'stefan-frontend' }, deps)
      expect(deps.session.sessionName).toBe('stefan-frontend')
    })

    it('list_sessions returns de-duplicated sessions', async () => {
      const result = await handleSessionTool('list_sessions', {}, deps)
      expect(result).toContain('carlos-backend')
      expect(result).toContain('Working on API')
      expect(result).not.toContain('Idle')
    })

    it('set_status posts updated status to registry', async () => {
      await handleSessionTool('set_status', { status: 'Reviewing PR #42' }, deps)
      expect(deps.webClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_REGISTRY',
        text: ':robot_face: *[stefan-dispatcher]* status | Reviewing PR #42',
      })
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tests/tools/session.test.ts`
Expected: FAIL - cannot resolve

- [ ] **Step 3: Implement src/tools/session.ts**

```ts
import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'

export interface SessionToolDeps {
  session: SessionManager
  webClient: WebClient
  registryChannelId: string
}

const ANNOUNCE_PATTERN = /:robot_face: \*\[(.+?)\]\* online \| Role: (.+?)(?:\s*\|\s*Status: (.+))?$/
const STATUS_PATTERN = /:robot_face: \*\[(.+?)\]\* status \| (.+)$/

export function createSessionTools() {
  return [
    {
      name: 'announce_session',
      description: 'Register this session in the global registry so other sessions can discover you.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          role: { type: 'string' as const, description: 'Your role (e.g., frontend, backend, fullstack)' },
          status: { type: 'string' as const, description: 'Optional status message' },
          name_override: { type: 'string' as const, description: 'Override the auto-derived session name' },
        },
        required: ['role'],
      },
    },
    {
      name: 'list_sessions',
      description: 'List all sessions currently registered in the global registry.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'set_status',
      description: 'Update this session\'s status in the registry.',
      inputSchema: {
        type: 'object' as const,
        properties: { status: { type: 'string' as const, description: 'New status message' } },
        required: ['status'],
      },
    },
  ]
}

export async function handleSessionTool(
  name: string, args: Record<string, unknown>, deps: SessionToolDeps
): Promise<string> {
  switch (name) {
    case 'announce_session': {
      const { role, status, name_override } = args as { role: string; status?: string; name_override?: string }
      if (name_override) deps.session.overrideName(name_override)
      let text = `:robot_face: *[${deps.session.sessionName}]* online | Role: ${role}`
      if (status) text += ` | Status: ${status}`
      await deps.webClient.chat.postMessage({ channel: deps.registryChannelId, text })
      return `Session "${deps.session.sessionName}" announced with role "${role}"`
    }
    case 'list_sessions': {
      const result = await deps.webClient.conversations.history({ channel: deps.registryChannelId, limit: 100 })
      const sessions = new Map<string, { role: string; status: string; ts: string }>()
      for (const msg of result.messages ?? []) {
        const text = msg.text ?? ''
        const ts = msg.ts ?? ''
        const announceMatch = ANNOUNCE_PATTERN.exec(text)
        if (announceMatch) {
          const name = announceMatch[1]
          if (!sessions.has(name)) {
            sessions.set(name, { role: announceMatch[2], status: announceMatch[3] ?? '', ts })
          }
          continue
        }
        const statusMatch = STATUS_PATTERN.exec(text)
        if (statusMatch) {
          const existing = sessions.get(statusMatch[1])
          if (existing && ts > existing.ts) {
            existing.status = statusMatch[2]
            existing.ts = ts
          }
        }
      }
      if (sessions.size === 0) return 'No sessions currently registered.'
      const lines = ['Active sessions:']
      for (const [n, info] of sessions) {
        let line = `  - ${n} (${info.role})`
        if (info.status) line += ` - ${info.status}`
        lines.push(line)
      }
      return lines.join('\n')
    }
    case 'set_status': {
      const { status } = args as { status: string }
      await deps.webClient.chat.postMessage({
        channel: deps.registryChannelId,
        text: `:robot_face: *[${deps.session.sessionName}]* status | ${status}`,
      })
      return `Status updated: ${status}`
    }
    default:
      throw new Error(`Unknown session tool: ${name}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tests/tools/session.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/session.ts tests/tools/session.test.ts
git commit -m "feat(IRD-52): session management tools - announce, list, set_status"
```

---

### Task 7: MCP Tools - Channel Subscriptions (IRD-52)

**Files:**
- Create: `src/tools/channels.ts`
- Create: `tests/tools/channels.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/channels.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tests/tools/channels.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/tools/channels.ts**

```ts
import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'
import type { SubscriptionManager } from '../subscriptions.js'

export interface ChannelToolDeps {
  session: SessionManager
  webClient: WebClient
  subscriptionManager: SubscriptionManager
}

export function createChannelTools() {
  return [
    {
      name: 'subscribe_channel',
      description: 'Join a Slack channel and start receiving pushed events from it.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          read_history: { type: 'boolean' as const, description: 'Read recent history (default: true)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'unsubscribe_channel',
      description: 'Stop receiving events from a channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          post_departure: { type: 'boolean' as const, description: 'Post departure message (default: true)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'list_subscriptions',
      description: 'List all channels this session is subscribed to.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ]
}

export async function handleChannelTool(
  name: string, args: Record<string, unknown>, deps: ChannelToolDeps
): Promise<string> {
  switch (name) {
    case 'subscribe_channel': {
      const { channel, read_history } = args as { channel: string; read_history?: boolean }
      const { channelId, alreadySubscribed } = await deps.subscriptionManager.join(channel)
      await deps.webClient.chat.postMessage({
        channel: channelId,
        text: `:robot_face: *[${deps.session.sessionName}]* joined the channel`,
      })
      const lines = [`Subscribed to #${channel}${alreadySubscribed ? ' (was already subscribed)' : ''}`]
      if (read_history !== false) {
        const history = await deps.webClient.conversations.history({ channel: channelId, limit: 20 })
        if (history.messages && history.messages.length > 0) {
          lines.push('', 'Recent messages:')
          for (const msg of history.messages.reverse()) {
            lines.push(`  ${msg.text ?? '(empty)'}`)
          }
        }
      }
      return lines.join('\n')
    }
    case 'unsubscribe_channel': {
      const { channel, post_departure } = args as { channel: string; post_departure?: boolean }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      if (post_departure !== false) {
        await deps.webClient.chat.postMessage({
          channel: channelId,
          text: `:wave: *[${deps.session.sessionName}]* left the channel`,
        })
      }
      deps.subscriptionManager.leave(channelId)
      return `Unsubscribed from #${channel}.`
    }
    case 'list_subscriptions': {
      const ids = deps.subscriptionManager.getSubscriptions()
      if (ids.length === 0) return 'No active subscriptions.'
      const lines = ['Active subscriptions:']
      for (const id of ids) {
        lines.push(`  - #${deps.subscriptionManager.getChannelName(id) ?? id}`)
      }
      return lines.join('\n')
    }
    default:
      throw new Error(`Unknown channel tool: ${name}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tests/tools/channels.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/channels.ts tests/tools/channels.test.ts
git commit -m "feat(IRD-52): channel subscription tools - subscribe, unsubscribe, list"
```

---

### Task 8: MCP Tools - Conversations (IRD-53)

**Files:**
- Create: `src/tools/conversations.ts`
- Create: `tests/tools/conversations.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tools/conversations.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tests/tools/conversations.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/tools/conversations.ts**

```ts
import type { WebClient } from '@slack/web-api'
import type { SessionManager } from '../session.js'
import type { SubscriptionManager } from '../subscriptions.js'
import { SessionManager as SM } from '../session.js'

export interface ConversationToolDeps {
  session: SessionManager
  webClient: WebClient
  subscriptionManager: SubscriptionManager
}

const TOPIC_PATTERN = /^:(large_green_circle|white_check_mark): TOPIC: (.+?) \| \*\[(.+?)\]\*$/

export function createConversationTools() {
  return [
    {
      name: 'start_conversation',
      description: 'Start a new conversation (thread) in a team channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          topic: { type: 'string' as const, description: 'Conversation topic' },
          detail: { type: 'string' as const, description: 'Additional detail' },
          participants_needed: { type: 'string' as const, description: 'Roles or people needed' },
        },
        required: ['channel', 'topic'],
      },
    },
    {
      name: 'join_conversation',
      description: 'Join an existing conversation. Fetches history and announces presence.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          thread_ts: { type: 'string' as const, description: 'Thread timestamp (conversation ID)' },
        },
        required: ['channel', 'thread_ts'],
      },
    },
    {
      name: 'reply_in_conversation',
      description: 'Post a reply in an existing conversation thread.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          thread_ts: { type: 'string' as const, description: 'Thread timestamp' },
          text: { type: 'string' as const, description: 'Message text' },
        },
        required: ['channel', 'thread_ts', 'text'],
      },
    },
    {
      name: 'list_conversations',
      description: 'List conversations in a channel with topic, author, reply count, and status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          include_resolved: { type: 'boolean' as const, description: 'Include resolved conversations (default: false)' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'resolve_conversation',
      description: 'Mark a conversation as resolved with a summary.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string' as const, description: 'Channel name' },
          thread_ts: { type: 'string' as const, description: 'Thread timestamp' },
          summary: { type: 'string' as const, description: 'Resolution summary' },
        },
        required: ['channel', 'thread_ts', 'summary'],
      },
    },
  ]
}

export async function handleConversationTool(
  name: string, args: Record<string, unknown>, deps: ConversationToolDeps
): Promise<string> {
  switch (name) {
    case 'start_conversation': {
      const { channel, topic, detail, participants_needed } = args as {
        channel: string; topic: string; detail?: string; participants_needed?: string
      }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      let text = `:large_green_circle: TOPIC: ${topic} | *[${deps.session.sessionName}]*`
      if (detail) text += `\n${detail}`
      if (participants_needed) text += `\nNeeded: ${participants_needed}`
      const result = await deps.webClient.chat.postMessage({ channel: channelId, text })
      const threadTs = result.ts ?? 'unknown'
      return `Conversation started: "${topic}" in #${channel}\nthread_ts: ${threadTs}\nOthers can join with: join_conversation(channel: "${channel}", thread_ts: "${threadTs}")`
    }
    case 'join_conversation': {
      const { channel, thread_ts } = args as { channel: string; thread_ts: string }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      const replies = await deps.webClient.conversations.replies({ channel: channelId, ts: thread_ts })
      await deps.webClient.chat.postMessage({
        channel: channelId, thread_ts,
        text: `:robot_face: *[${deps.session.sessionName}]* joined the conversation`,
      })
      const lines = ['Conversation history:']
      for (const msg of replies.messages ?? []) {
        const parsed = SM.parse(msg.text ?? '')
        const sender = parsed ? parsed.sender : `user:${msg.user ?? 'unknown'}`
        const content = parsed ? parsed.text : (msg.text ?? '')
        lines.push(`  [${sender}]: ${content}`)
      }
      return lines.join('\n')
    }
    case 'reply_in_conversation': {
      const { channel, thread_ts, text } = args as { channel: string; thread_ts: string; text: string }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      await deps.webClient.chat.postMessage({ channel: channelId, thread_ts, text: deps.session.fmt(text) })
      return `Reply sent in thread ${thread_ts}`
    }
    case 'list_conversations': {
      const { channel, include_resolved } = args as { channel: string; include_resolved?: boolean }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      const history = await deps.webClient.conversations.history({ channel: channelId, limit: 50 })
      const convos: Array<{ topic: string; author: string; threadTs: string; replyCount: number; resolved: boolean }> = []
      for (const msg of history.messages ?? []) {
        const match = TOPIC_PATTERN.exec(msg.text ?? '')
        if (!match) continue
        const resolved = match[1] === 'white_check_mark'
        if (!include_resolved && resolved) continue
        convos.push({ topic: match[2], author: match[3], threadTs: msg.ts ?? '', replyCount: msg.reply_count ?? 0, resolved })
      }
      if (convos.length === 0) return `No ${include_resolved ? '' : 'active '}conversations in #${channel}.`
      const lines = [`Conversations in #${channel}:`]
      for (const c of convos) {
        const status = c.resolved ? ':white_check_mark:' : ':large_green_circle:'
        lines.push(`  ${status} "${c.topic}" by ${c.author} (${c.replyCount} replies) - thread_ts: ${c.threadTs}`)
      }
      return lines.join('\n')
    }
    case 'resolve_conversation': {
      const { channel, thread_ts, summary } = args as { channel: string; thread_ts: string; summary: string }
      const channelId = await deps.subscriptionManager.resolveChannelId(channel)
      await deps.webClient.chat.postMessage({
        channel: channelId, thread_ts,
        text: `:white_check_mark: RESOLVED by *[${deps.session.sessionName}]*\n${summary}`,
      })
      return `Conversation ${thread_ts} resolved: ${summary}`
    }
    default:
      throw new Error(`Unknown conversation tool: ${name}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tests/tools/conversations.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/conversations.ts tests/tools/conversations.test.ts
git commit -m "feat(IRD-53): conversation tools - start, join, reply, list, resolve"
```

---

### Task 9: MCP Server Entry Point (IRD-48, IRD-55)

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: Implement src/server.ts**

```ts
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
      const mainWorktree = worktrees[0].split('\n')[0].replace('worktree ', '')
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
```

- [ ] **Step 2: Verify the project compiles**

Run: `yarn build`
Expected: tsc completes with no errors

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(IRD-48,IRD-55): MCP server entry point with Channel protocol and tool registration"
```

---

### Task 10: Integration Tests (IRD-56)

**Files:**
- Create: `tests/integration.test.ts`

- [ ] **Step 1: Write integration tests**

Create `tests/integration.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { SessionManager } from '../src/session.js'
import { SubscriptionManager } from '../src/subscriptions.js'
import { MessageBus } from '../src/message-bus.js'
import type { ParsedMessage } from '../src/types.js'

describe('Integration: end-to-end message flow', () => {
  it('routes inbound message through pipeline to Channel notification', async () => {
    const mockMcp = { notification: vi.fn().mockResolvedValue(undefined) }
    const bus = new MessageBus(mockMcp as never)

    const msg: ParsedMessage = {
      sender: 'carlos-backend', text: 'Need help with auth', ts: '500.100', channel: 'C123', threadTs: '500.001',
    }
    await bus.push(msg)

    expect(mockMcp.notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Need help with auth',
        meta: { sender: 'carlos-backend', channel: 'C123', ts: '500.100', thread_ts: '500.001' },
      },
    })
  })

  it('full subscribe -> receive -> reply flow', async () => {
    const mockMcp = { notification: vi.fn().mockResolvedValue(undefined) }
    const mockWeb = {
      conversations: {
        join: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue({ ok: true, channels: [{ id: 'C123', name: 'team-alpha-collab' }] }),
      },
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '100.200' }) },
    }
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    const subs = new SubscriptionManager(mockWeb as never)
    const bus = new MessageBus(mockMcp as never)

    await subs.join('team-alpha-collab')
    expect(subs.isSubscribed('C123')).toBe(true)

    await bus.push({ sender: 'alice-frontend', text: 'Review my PR?', ts: '600.100', channel: 'C123', threadTs: '600.001' })

    expect(mockMcp.notification).toHaveBeenCalledWith(expect.objectContaining({
      method: 'notifications/claude/channel',
      params: expect.objectContaining({ content: 'Review my PR?' }),
    }))

    await mockWeb.chat.postMessage({ channel: 'C123', thread_ts: '600.001', text: session.fmt('Sure, on it') })
    expect(mockWeb.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123', thread_ts: '600.001', text: '*[stefan-dispatcher]*: Sure, on it',
    })
  })

  it('session identity parsing round-trips correctly', () => {
    const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
    const parsed = SessionManager.parse(session.fmt('hello world'))
    expect(parsed).toEqual({ sender: 'stefan-dispatcher', text: 'hello world' })
  })

  it('human messages return null from parse', () => {
    expect(SessionManager.parse('just a regular slack message')).toBeNull()
  })
})
```

- [ ] **Step 2: Run full test suite**

Run: `yarn test`
Expected: All tests pass across all files

- [ ] **Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test(IRD-56): integration tests for end-to-end message flow"
```

---

### Task 11: Config Files & Final Verification (IRD-57)

**Files:**
- Create: `.mcp.json`
- Create: `.env.example`

- [ ] **Step 1: Create .mcp.json**

```json
{
  "mcpServers": {
    "slack-collab": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"]
    }
  }
}
```

- [ ] **Step 2: Create .env.example**

```
# Required: Slack Bot User OAuth Token (xoxb-...)
SLACK_BOT_TOKEN=

# Required: Slack App-Level Token (xapp-...) with connections:write scope
SLACK_APP_TOKEN=

# Required: Your name, used as session name prefix
USERNAME=

# Optional: Default role for announce_session
SESSION_ROLE=

# Optional: Registry channel name (default: ai-collab-registry)
REGISTRY_CHANNEL=
```

- [ ] **Step 3: Run full test suite**

Run: `yarn test`
Expected: All tests pass

- [ ] **Step 4: Verify TypeScript compilation**

Run: `yarn build`
Expected: No errors

- [ ] **Step 5: Verify no credentials in source**

Run: `grep -r "xoxb-[a-zA-Z0-9]\|xapp-[a-zA-Z0-9]\|sk-[a-zA-Z0-9]" src/ tests/ --include="*.ts"`
Expected: No matches

- [ ] **Step 6: Commit**

```bash
git add .mcp.json .env.example
git commit -m "feat(IRD-57): MCP config and environment variable template"
```
