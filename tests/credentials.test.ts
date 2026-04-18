import { describe, it, expect, afterEach } from 'vitest'
import { getCredentialsPath } from '../src/credentials.js'

describe('getCredentialsPath', () => {
  afterEach(() => {
    delete process.env.SLACK_PROFILE
  })

  it('returns default path when no profile is set', () => {
    delete process.env.SLACK_PROFILE
    expect(getCredentialsPath()).toMatch(/\/\.config\/cccollab\/credentials\.json$/)
  })

  it('returns profile-specific path when SLACK_PROFILE is set', () => {
    process.env.SLACK_PROFILE = 'user1'
    expect(getCredentialsPath()).toMatch(/\/\.config\/cccollab\/credentials-user1\.json$/)
  })

  it('falls back to default when profile is empty/whitespace', () => {
    process.env.SLACK_PROFILE = '   '
    expect(getCredentialsPath()).toMatch(/\/credentials\.json$/)
  })
})
