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
