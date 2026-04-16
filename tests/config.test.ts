import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/credentials.js', () => ({
  loadCredentials: vi.fn(),
}))

import { loadConfig } from '../src/config.js'
import { loadCredentials } from '../src/credentials.js'

const mockLoadCredentials = vi.mocked(loadCredentials)

describe('loadConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns unauthenticated config when no credentials exist', () => {
    mockLoadCredentials.mockReturnValue(null)

    const config = loadConfig()

    expect(config.authenticated).toBe(false)
  })

  it('returns authenticated config with full fields when credentials exist', () => {
    mockLoadCredentials.mockReturnValue({
      botToken: 'xoxb-test-bot-token',
      userToken: 'xoxp-test-user-token',
      teamId: 'T12345',
      teamName: 'Test Workspace',
      userId: 'U12345',
      userName: 'stefan',
    })

    const config = loadConfig()

    expect(config.authenticated).toBe(true)
    if (!config.authenticated) throw new Error('Expected authenticated config')
    expect(config.slackBotToken).toBe('xoxb-test-bot-token')
    expect(config.slackUserToken).toBe('xoxp-test-user-token')
    expect(config.username).toBe('stefan')
    expect(config.registryChannel).toBe('ai-collab-registry')
    expect(config.brokerPort).toBe(7850)
  })

  it('uses app token from constants', () => {
    mockLoadCredentials.mockReturnValue({
      botToken: 'xoxb-test',
      userToken: 'xoxp-test',
      teamId: 'T1',
      teamName: 'Test',
      userId: 'U1',
      userName: 'test',
    })

    const config = loadConfig()

    expect(config.authenticated).toBe(true)
    if (!config.authenticated) throw new Error('Expected authenticated config')
    expect(config.slackAppToken).toMatch(/^xapp-/)
  })
})
