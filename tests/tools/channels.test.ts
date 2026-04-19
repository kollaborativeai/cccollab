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
        'list_channels', 'join_channel', 'leave_channel', 'set_active_channel', 'send_message_to_channel',
      ])
    })
  })

  describe('requires name', () => {
    it('rejects when session has no name', async () => {
      const deps = createDeps()
      const session = new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' })
      const noName = { ...deps, session }
      const result = await handleChannelTool('join_channel', { name: 'x' }, noName)
      expect(result).toContain('no name set')
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
      const result = await handleChannelTool('list_channels', {}, depsNoName)
      expect(result).not.toContain('no name set')
      expect(result).toContain('default')
      expect(result).toContain('fallback')
      vi.unstubAllGlobals()
    })
  })

  describe('join_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => { deps = createDeps() })
    afterEach(() => { vi.unstubAllGlobals() })

    it('posts to broker and updates context', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      const result = await handleChannelTool('join_channel', { name: 'Project_X' }, deps)
      expect(result).toContain('project_x')
      expect(result).toContain('active channel')
      expect(deps.context.isChannelSubscribed('project_x')).toBe(true)
      expect(deps.context.getActiveChannel()).toBe('project_x')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/channels/join'),
        expect.objectContaining({ method: 'POST' }),
      )
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('project_x')
      expect(body.sessionId).toBe('architect')
    })

    it('does not change active channel when already have one', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      const result = await handleChannelTool('join_channel', { name: 'project_x' }, deps)
      expect(result).toContain('unchanged')
      expect(deps.context.getActiveChannel()).toBe('default')
    })

    it('rejects empty name', async () => {
      const result = await handleChannelTool('join_channel', { name: '   ' }, deps)
      expect(result).toContain('non-empty')
    })
  })

  describe('leave_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => { deps = createDeps() })
    afterEach(() => { vi.unstubAllGlobals() })

    it('leaves a subscribed channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = await handleChannelTool('leave_channel', { name: 'default' }, deps)
      expect(result).toContain('Left "default"')
      expect(result).toContain('project_x')
      expect(deps.context.isChannelSubscribed('default')).toBe(false)
      expect(deps.context.getActiveChannel()).toBe('project_x')
    })

    it('leaves only channel clears active', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      const result = await handleChannelTool('leave_channel', { name: 'default' }, deps)
      expect(result).toContain('No active channel')
      expect(deps.context.getActiveChannel()).toBeUndefined()
    })

    it('errors when not subscribed', async () => {
      const result = await handleChannelTool('leave_channel', { name: 'nope' }, deps)
      expect(result).toContain('Not subscribed')
    })
  })

  describe('set_active_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => { deps = createDeps() })

    it('sets active channel when subscribed', async () => {
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = await handleChannelTool('set_active_channel', { name: 'project_x' }, deps)
      expect(result).toContain('project_x')
      expect(deps.context.getActiveChannel()).toBe('project_x')
    })

    it('friendly error when not subscribed', async () => {
      const result = await handleChannelTool('set_active_channel', { name: 'nope' }, deps)
      expect(result).toContain('Not subscribed')
      expect(result).toContain('join_channel')
    })
  })

  describe('list_channels', () => {
    let deps: ChannelToolDeps
    beforeEach(() => { deps = createDeps() })
    afterEach(() => { vi.unstubAllGlobals() })

    it('returns "No channels" when none subscribed', async () => {
      const result = await handleChannelTool('list_channels', {}, deps)
      expect(result).toContain('No channels')
    })

    it('marks the active channel and shows source', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ channels: [
          { name: 'default', subscriberCount: 3 },
          { name: 'project_x', subscriberCount: 2 },
        ] }),
      })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = await handleChannelTool('list_channels', {}, deps)
      expect(result).toContain('default')
      expect(result).toContain('project_x')
      expect(result).toContain('[active]')
      expect(result).toContain('fallback')
      expect(result).toContain('manual')
      expect(result).toContain('3 subscribers')
    })
  })

  describe('send_message_to_channel', () => {
    let deps: ChannelToolDeps
    beforeEach(() => { deps = createDeps() })
    afterEach(() => { vi.unstubAllGlobals() })

    it('posts to active channel when no channel arg', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      const result = await handleChannelTool('send_message_to_channel', { text: 'hi' }, deps)
      expect(result).toContain('default')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('default')
      expect(body.text).toBe('hi')
    })

    it('posts to explicit channel when provided and subscribed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) })
      vi.stubGlobal('fetch', mockFetch)
      deps.context.joinChannel('default', 'fallback')
      deps.context.joinChannel('project_x', 'manual')
      const result = await handleChannelTool('send_message_to_channel', { text: 'hi', channel: 'project_x' }, deps)
      expect(result).toContain('project_x')
      const body = JSON.parse((mockFetch.mock.calls[0]![1]! as RequestInit).body as string)
      expect(body.channel).toBe('project_x')
    })

    it('errors when not subscribed to the target channel', async () => {
      deps.context.joinChannel('default', 'fallback')
      const result = await handleChannelTool('send_message_to_channel', { text: 'hi', channel: 'foo' }, deps)
      expect(result).toContain('Not subscribed')
    })

    it('errors when no active channel and no arg', async () => {
      const result = await handleChannelTool('send_message_to_channel', { text: 'hi' }, deps)
      expect(result).toContain('No active channel')
    })

    it('rejects empty text', async () => {
      const result = await handleChannelTool('send_message_to_channel', { text: '' }, deps)
      expect(result).toContain('non-empty')
    })
  })
})
