import { describe, it, expect, beforeEach } from 'vitest'
import { createIdentityTools, handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'

function createMockDeps(): IdentityToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
  }
}

describe('Identity Tools', () => {
  describe('createIdentityTools', () => {
    it('returns 1 tool definition', () => {
      const tools = createIdentityTools()
      expect(tools).toHaveLength(1)
      expect(tools.map((t) => t.name)).toEqual(['introduce'])
    })
  })

  describe('handleIdentityTool', () => {
    let deps: IdentityToolDeps

    beforeEach(() => { deps = createMockDeps() })

    it('introduce sets display name on session', async () => {
      await handleIdentityTool('introduce', { name: 'architect' }, deps)
      expect(deps.session.displayName).toBe('architect')
    })

    it('introduce returns confirmation with name', async () => {
      const result = await handleIdentityTool('introduce', { name: 'architect' }, deps)
      expect(result).toContain('architect')
    })

    it('introduce includes objective in confirmation when provided', async () => {
      const result = await handleIdentityTool('introduce', { name: 'architect', objective: 'reviewing auth module' }, deps)
      expect(result).toContain('reviewing auth module')
    })

    it('throws on unknown tool', async () => {
      await expect(handleIdentityTool('unknown_tool', {}, deps)).rejects.toThrow('Unknown identity tool')
    })
  })
})
