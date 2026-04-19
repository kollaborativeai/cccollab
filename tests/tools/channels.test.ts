import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createChannelTools, handleChannelTool, type ChannelToolDeps } from '../../src/tools/channels.js'
import { SessionManager } from '../../src/session.js'
import { ActiveContext } from '../../src/context.js'

function createDeps(): ChannelToolDeps {
  const context = new ActiveContext()
  const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
  session.setName('architect')
  return { session, context, brokerPort: 7850 }
}

describe('Channel Tools', () => {
  describe('createChannelTools', () => {
    it('returns 5 tool definitions', () => {
      expect(createChannelTools()).toHaveLength(5)
    })
    it('has the correct names', () => {
      expect(createChannelTools().map((t) => t.name)).toEqual([
        'list_channels',
        'join_channel',
        'leave_channel',
        'set_active_channel',
        'send_message_to_channel',
      ])
    })
  })

  describe('requires name', () => {
    it('rejects when session has no name', async () => {
      const deps = createDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const noName = { ...deps, session }
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'x' }, noName))
      expect(result.error).toContain('No name set')
    })

    it('allows list_channels without name', async () => {
      const deps = createDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const depsNoName = { ...deps, session }
      depsNoName.context.joinChannel('default', 'fallback')
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ channels: [{ name: 'default', subscriberCount: 1 }] }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleChannelTool('list_channels', {}, depsNoName))
      expect(result).toEqual({
        activeChannel: 'default',
        channels: [{ name: 'default', source: 'fallback', subscriberCount: 1, subscribed: true, isActive: true }],
      })
      vi.unstubAllGlobals()
    })
  })

  describe('join_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts to broker and updates context', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscriberCount: 1 }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'Project_X' }, deps))
      expect(result).toEqual({ channel: 'project_x', becameActive: true, subscriberCount: 1 })
      expect(deps.context.isChannelSubscribed('project_x')).toBe(true)
      expect(deps.context.getActiveChannel()).toBe('project_x')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('project_x')
      expect(body.sessionId).toBe('architect')
    })

    it('does not change active channel when already have one', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscriberCount: 2 }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      const result = JSON.parse(await handleChannelTool('join_channel', { name: 'project_x' }, deps))
      expect(result.becameActive).toBe(false)
      expect(deps.context.getActiveChannel()).toBe('default')
    })

    it('rejects empty name', async () => {
      const result = JSON.parse(await handleChannelTool('join_channel', { name: '   ' }, deps))
      expect(result.error).toContain('non-empty')
    })
  })

  describe('leave_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('leaves a subscribed channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = JSON.parse(await handleChannelTool('leave_channel', { name: 'default' }, deps))
      expect(result).toEqual({ channel: 'default', removed: true, newActiveChannel: 'project_x' })
      expect(deps.context.isChannelSubscribed('default')).toBe(false)
      expect(deps.context.getActiveChannel()).toBe('project_x')
    })

    it('leaves only channel clears active', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      const result = JSON.parse(await handleChannelTool('leave_channel', { name: 'default' }, deps))
      expect(result.newActiveChannel).toBeNull()
      expect(deps.context.getActiveChannel()).toBeUndefined()
    })

    it('errors when not subscribed', async () => {
      const result = JSON.parse(await handleChannelTool('leave_channel', { name: 'nope' }, deps))
      expect(result.error).toContain('Not subscribed')
    })
  })

  describe('set_active_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })

    it('sets active channel when subscribed', async () => {
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = JSON.parse(await handleChannelTool('set_active_channel', { name: 'project_x' }, deps))
      expect(result).toEqual({ activeChannel: 'project_x' })
      expect(deps.context.getActiveChannel()).toBe('project_x')
    })

    it('friendly error when not subscribed', async () => {
      const result = JSON.parse(await handleChannelTool('set_active_channel', { name: 'nope' }, deps))
      expect(result.error).toContain('Not subscribed')
      expect(result.error).toContain('join_channel')
    })
  })

  describe('list_channels', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('returns empty channels array with null activeChannel when none subscribed and broker sees none', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ channels: [] }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result).toEqual({ activeChannel: null, channels: [] })
    })

    it('marks the active channel, shows source, and hoists activeChannel to the top level', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            channels: [
              { name: 'default', subscriberCount: 3 },
              { name: 'project_x', subscriberCount: 2 },
            ],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result).toEqual({
        activeChannel: 'default',
        channels: [
          { name: 'default', source: 'fallback', subscriberCount: 3, subscribed: true, isActive: true },
          { name: 'project_x', source: 'manual', subscriberCount: 2, subscribed: true, isActive: false },
        ],
      })
    })

    it('queries the broker global view without a sessionId', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ channels: [] }) })
      vi.stubGlobal('fetch', mockFetch)
      await handleChannelTool('list_channels', {}, deps)
      const url = mockFetch.mock.calls[0]![0] as string
      expect(url).toContain('/channels')
      expect(url).not.toContain('sessionId')
    })

    it('includes broker channels the session has not joined with subscribed:false and source:null', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            channels: [
              { name: 'cccollab', subscriberCount: 1 },
              { name: 'flatoutsolutions-ai', subscriberCount: 3 },
            ],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('cccollab', 'cccollab.json')
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result).toEqual({
        activeChannel: 'cccollab',
        channels: [
          { name: 'cccollab', source: 'cccollab.json', subscriberCount: 1, subscribed: true, isActive: true },
          {
            name: 'flatoutsolutions-ai',
            source: null,
            subscriberCount: 3,
            subscribed: false,
            isActive: false,
          },
        ],
      })
    })

    it('returns null activeChannel when no active channel is set', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            channels: [{ name: 'broadcast', subscriberCount: 5 }],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result.activeChannel).toBeNull()
      expect(result.channels).toEqual([
        { name: 'broadcast', source: null, subscriberCount: 5, subscribed: false, isActive: false },
      ])
    })

    it('still lists a locally-subscribed channel the broker did not report (fallback subscriberCount 1)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            channels: [{ name: 'other', subscriberCount: 4 }],
          }),
      })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('local_only', 'manual')
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result.activeChannel).toBe('local_only')
      expect(result.channels).toContainEqual({
        name: 'local_only',
        source: 'manual',
        subscriberCount: 1,
        subscribed: true,
        isActive: true,
      })
      expect(result.channels).toContainEqual({
        name: 'other',
        source: null,
        subscriberCount: 4,
        subscribed: false,
        isActive: false,
      })
    })

    it('degrades gracefully when broker is unreachable and returns subscribed-only entries', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = JSON.parse(await handleChannelTool('list_channels', {}, deps))
      expect(result).toEqual({
        activeChannel: 'default',
        channels: [
          { name: 'default', source: 'fallback', subscriberCount: 1, subscribed: true, isActive: true },
          { name: 'project_x', source: 'manual', subscriberCount: 1, subscribed: true, isActive: false },
        ],
      })
    })
  })

  describe('send_message_to_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => {
      deps = createDeps()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts to active channel when no channel arg', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      const result = JSON.parse(await handleChannelTool('send_message_to_channel', { text: 'hi' }, deps))
      expect(result).toEqual({ channel: 'default' })
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('default')
      expect(body.text).toBe('hi')
    })

    it('posts to explicit channel when provided and subscribed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = JSON.parse(
        await handleChannelTool('send_message_to_channel', { text: 'hi', channel: 'project_x' }, deps),
      )
      expect(result).toEqual({ channel: 'project_x' })
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('project_x')
    })

    it('errors when not subscribed to the target channel', async () => {
      deps.context.joinChannel('default', 'fallback')
      const result = JSON.parse(
        await handleChannelTool('send_message_to_channel', { text: 'hi', channel: 'foo' }, deps),
      )
      expect(result.error).toContain('Not subscribed')
    })

    it('errors when no active channel and no arg', async () => {
      const result = JSON.parse(await handleChannelTool('send_message_to_channel', { text: 'hi' }, deps))
      expect(result.error).toContain('No active channel')
    })

    it('rejects empty text', async () => {
      const result = JSON.parse(await handleChannelTool('send_message_to_channel', { text: '' }, deps))
      expect(result.error).toContain('non-empty')
    })
  })
})
