import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerTools, type ToolDeps } from '../src/server.js'
import { SessionManager } from '../src/session.js'
import { ActiveContext } from '../src/context.js'
import { MessageBus } from '../src/message-bus.js'
import { LocalTransport } from '../src/transport/local.js'
import { TransportRouter } from '../src/transport/router.js'
import { AttachDiagnostics } from '../src/transport/diagnostics.js'

/**
 * The zod `inputSchema` on each registered tool is the real argument boundary:
 * the MCP SDK silently DROPS any argument the schema does not declare. A
 * feature flag missing from the schema would therefore no-op in production
 * while every handler-level unit test still passed — the exact silent-miss
 * class KAI-414 exists to eliminate. These tests drive the tools through a
 * real MCP client so the schema is exercised, not bypassed.
 */
async function connectClient(deps: ToolDeps): Promise<Client> {
  const mcp = new McpServer({ name: 'cccollab-test', version: '0.0.0' }, { capabilities: { tools: {} } })
  registerTools(mcp, deps)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function createDeps(): ToolDeps {
  const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
  session.setName('orchestrator')
  const context = new ActiveContext()
  return {
    session,
    context,
    router: new TransportRouter([new LocalTransport(7850)]),
    locations: [],
    messageBus: new MessageBus({ notification: vi.fn().mockResolvedValue(undefined) } as never),
    remoteTopicUnsubscribes: new Map(),
    remoteChannelUnsubscribes: new Map(),
    cwd: '/projects/dispatcher',
    env: {},
    ensureAttached: async () => {},
    diagnostics: new AttachDiagnostics(),
  }
}

function firstText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content
  return content[0]!.text
}

describe('join_channel tool schema (KAI-414)', () => {
  let deps: ToolDeps

  beforeEach(() => {
    deps = createDeps()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscriberCount: 1 }) }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('advertises the watch argument so clients can discover channel-wide mode', async () => {
    const client = await connectClient(deps)
    const { tools } = await client.listTools()
    const joinChannel = tools.find((t) => t.name === 'join_channel')
    expect(joinChannel).toBeDefined()
    expect(joinChannel!.inputSchema.properties).toHaveProperty('watch')
  })

  it('passes watch: true through the MCP boundary instead of dropping it', async () => {
    const client = await connectClient(deps)
    const result = await client.callTool({ name: 'join_channel', arguments: { name: 'kai', watch: true } })

    // If `watch` were absent from the zod inputSchema, the SDK would strip it
    // and this would come back `watching: false` — a silently dead feature.
    expect(JSON.parse(firstText(result)).watching).toBe(true)
    expect(deps.context.isChannelWatched('kai', 'local')).toBe(true)
  })

  it('leaves a session unwatched when watch is not passed', async () => {
    const client = await connectClient(deps)
    const result = await client.callTool({ name: 'join_channel', arguments: { name: 'kai' } })

    expect(JSON.parse(firstText(result)).watching).toBe(false)
    expect(deps.context.isChannelWatched('kai', 'local')).toBe(false)
  })
})

/**
 * The ambiguity guard has to survive TWO things that hid it before:
 *  - zod: a `.default('local')` on `location` fills the argument in before the
 *    handler runs, so "the caller said nothing" becomes indistinguishable from
 *    "the caller chose local" and the guard is dead code on the only path that
 *    matters. Hence: through a real client, not the handler.
 *  - the router: a configured remote that has not been attached yet is absent
 *    from `router.enabled()`. A fresh orchestrator — the exact user of watch
 *    mode — is precisely the session whose remotes are still dormant.
 */
describe('join_channel ambiguous watch guard (KAI-414)', () => {
  function depsWithDormantRemote(): ToolDeps {
    const deps = createDeps()
    // Configured but NOT attached: the router still holds local only.
    deps.locations = [
      { name: 'local', isLocal: true, channels: [] },
      { name: 'flatout', isLocal: false, url: 'https://example.invalid', channels: [] },
    ]
    return deps
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscriberCount: 1 }) }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses a watch with no location when a remote is configured but still dormant', async () => {
    const deps = depsWithDormantRemote()
    const client = await connectClient(deps)
    const result = await client.callTool({ name: 'join_channel', arguments: { name: 'kai', watch: true } })

    const parsed = JSON.parse(firstText(result))
    expect(parsed.error).toMatch(/location/i)
    expect(parsed.error).toContain('flatout')
    // And it must fail BEFORE joining: no empty local channel left behind.
    expect(deps.context.isChannelSubscribed('kai', 'local')).toBe(false)
    expect(deps.context.isChannelWatched('kai', 'local')).toBe(false)
  })

  it('allows an explicit local watch when a remote is configured', async () => {
    const deps = depsWithDormantRemote()
    const client = await connectClient(deps)
    const result = await client.callTool({
      name: 'join_channel',
      arguments: { name: 'kai', location: 'local', watch: true },
    })

    const parsed = JSON.parse(firstText(result))
    expect(parsed.error).toBeUndefined()
    expect(parsed.watching).toBe(true)
  })

  it('still defaults location to local for a plain join when a remote is configured', async () => {
    const deps = depsWithDormantRemote()
    const client = await connectClient(deps)
    const result = await client.callTool({ name: 'join_channel', arguments: { name: 'kai' } })

    const parsed = JSON.parse(firstText(result))
    expect(parsed.error).toBeUndefined()
    expect(parsed.location).toBe('local')
    expect(deps.context.isChannelSubscribed('kai', 'local')).toBe(true)
  })
})
