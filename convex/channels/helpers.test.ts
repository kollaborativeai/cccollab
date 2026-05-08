import { describe, it, expect } from 'vitest'
import { ConvexError } from 'convex/values'

import { normalizeChannelName, requireNormalizedChannelName } from './helpers'

describe('normalizeChannelName', () => {
  it('lowercases and trims', () => {
    expect(normalizeChannelName('  Engineering  ')).toBe('engineering')
  })

  it('returns null for empty input', () => {
    expect(normalizeChannelName('')).toBeNull()
    expect(normalizeChannelName('   ')).toBeNull()
  })

  it('returns null for non-string input', () => {
    expect(normalizeChannelName(undefined)).toBeNull()
    expect(normalizeChannelName(null)).toBeNull()
    expect(normalizeChannelName(42)).toBeNull()
  })

  it('preserves internal punctuation', () => {
    expect(normalizeChannelName('ops-alerts')).toBe('ops-alerts')
    expect(normalizeChannelName('  #Important_Thing ')).toBe('#important_thing')
  })
})

describe('requireNormalizedChannelName', () => {
  it('returns the normalized value on valid input', () => {
    expect(requireNormalizedChannelName('  Eng  ')).toBe('eng')
  })

  it('throws INVALID_CHANNEL_NAME on empty input', () => {
    expect(() => requireNormalizedChannelName('')).toThrow(ConvexError)
  })

  it('throws INVALID_CHANNEL_NAME on non-string input', () => {
    expect(() => requireNormalizedChannelName(undefined)).toThrow(ConvexError)
  })
})
