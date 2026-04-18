import { describe, it, expect, beforeEach } from 'vitest'
import { createIdentityTools, handleIdentityTool, type IdentityToolDeps } from '../../src/tools/identity.js'
import { SessionManager } from '../../src/session.js'

function createMockDeps(): IdentityToolDeps {
  return {
    session: new SessionManager({ username: 'stefan', cwd: '/projects/dispatcher' }),
    brokerPort: 7850,
  }
}

describe('Identity Tools', () => {
  describe('createIdentityTools', () => {
    it('returns 2 tool definitions', () => {
      const tools = createIdentityTools()
      expect(tools).toHaveLength(2)
      expect(tools.map((t) => t.name)).toEqual(['introduce', 'whoami'])
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

    describe('whoami', () => {
      it('reports name and objective when both are set', async () => {
        await handleIdentityTool('introduce', { name: 'architect', objective: 'design the API' }, deps)
        const result = await handleIdentityTool('whoami', {}, deps)
        expect(result).toContain('Name: architect')
        expect(result).toContain('Objective: design the API')
      })

      it('reports "(not set)" for objective when only name is set', async () => {
        await handleIdentityTool('introduce', { name: 'architect' }, deps)
        const result = await handleIdentityTool('whoami', {}, deps)
        expect(result).toContain('Name: architect')
        expect(result).toContain('Objective: (not set)')
      })

      it('returns guidance when no name has been set', async () => {
        const result = await handleIdentityTool('whoami', {}, deps)
        expect(result).toContain('no identity set')
        expect(result).toContain('introduce')
      })
    })
  })
})
