import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/credentials.js', () => ({
  loadCredentials: vi.fn(),
}))

import { loadConfig } from '../src/config.js'
import { loadCredentials } from '../src/credentials.js'

const mockLoadCredentials = vi.mocked(loadCredentials)

describe('loadConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.DEFAULT_SLACK_CHANNEL
  })

  afterEach(() => {
    delete process.env.DEFAULT_SLACK_CHANNEL
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

  it('defaultChannel is undefined when env var is not set', () => {
    mockLoadCredentials.mockReturnValue({
      botToken: 'x', userToken: 'x', teamId: 'T', teamName: 'T', userId: 'U', userName: 'u',
    })
    const config = loadConfig()
    if (!config.authenticated) throw new Error('Expected authenticated config')
    expect(config.defaultChannel).toBeUndefined()
  })

  it('defaultChannel is read from DEFAULT_SLACK_CHANNEL env var', () => {
    process.env.DEFAULT_SLACK_CHANNEL = 'engineering'
    mockLoadCredentials.mockReturnValue({
      botToken: 'x', userToken: 'x', teamId: 'T', teamName: 'T', userId: 'U', userName: 'u',
    })
    const config = loadConfig()
    if (!config.authenticated) throw new Error('Expected authenticated config')
    expect(config.defaultChannel).toBe('engineering')
  })

  it('defaultChannel strips leading # from env var', () => {
    process.env.DEFAULT_SLACK_CHANNEL = '#engineering'
    mockLoadCredentials.mockReturnValue({
      botToken: 'x', userToken: 'x', teamId: 'T', teamName: 'T', userId: 'U', userName: 'u',
    })
    const config = loadConfig()
    if (!config.authenticated) throw new Error('Expected authenticated config')
    expect(config.defaultChannel).toBe('engineering')
  })

  it('defaultChannel is undefined when env var is empty/whitespace', () => {
    process.env.DEFAULT_SLACK_CHANNEL = '   '
    mockLoadCredentials.mockReturnValue({
      botToken: 'x', userToken: 'x', teamId: 'T', teamName: 'T', userId: 'U', userName: 'u',
    })
    const config = loadConfig()
    if (!config.authenticated) throw new Error('Expected authenticated config')
    expect(config.defaultChannel).toBeUndefined()
  })
})
