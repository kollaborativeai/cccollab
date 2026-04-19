import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveInitialProfile, PROFILE_FILE_NAME } from '../src/initial-profile.js'

describe('resolveInitialProfile', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cccollab-profile-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns "default" when neither env nor file is present', () => {
    expect(resolveInitialProfile(root, {})).toBe('default')
  })

  it('reads CCCOLLAB_PROFILE env var', () => {
    expect(resolveInitialProfile(root, { CCCOLLAB_PROFILE: 'myprofile' })).toBe('myprofile')
  })

  it('trims whitespace in env var', () => {
    expect(resolveInitialProfile(root, { CCCOLLAB_PROFILE: '  myprofile  ' })).toBe('myprofile')
  })

  it('treats empty env var as absent', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: 'from-file' }))
    expect(resolveInitialProfile(root, { CCCOLLAB_PROFILE: '' })).toBe('from-file')
  })

  it('treats whitespace-only env var as absent', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: 'from-file' }))
    expect(resolveInitialProfile(root, { CCCOLLAB_PROFILE: '   ' })).toBe('from-file')
  })

  it('env takes precedence over file', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: 'from-file' }))
    expect(resolveInitialProfile(root, { CCCOLLAB_PROFILE: 'from-env' })).toBe('from-env')
  })

  it('reads profile from .cccollab.json when env is unset', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: 'from-file' }))
    expect(resolveInitialProfile(root, {})).toBe('from-file')
  })

  it('falls back when file lacks profile key', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ name: 'only-name' }))
    expect(resolveInitialProfile(root, {})).toBe('default')
  })

  it('falls back and warns when profile is not a string', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: 123 }))
    expect(resolveInitialProfile(root, {})).toBe('default')
    expect(warn).toHaveBeenCalled()
  })

  it('falls back when profile is empty string', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: '' }))
    expect(resolveInitialProfile(root, {})).toBe('default')
  })

  it('falls back when profile is whitespace-only', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: '   ' }))
    expect(resolveInitialProfile(root, {})).toBe('default')
  })

  it('trims whitespace in profile from file', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: '  myprofile  ' }))
    expect(resolveInitialProfile(root, {})).toBe('myprofile')
  })

  it('walks up parent directories to find .cccollab.json', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify({ profile: 'alpha' }))
    const nested = path.join(root, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    expect(resolveInitialProfile(nested, {})).toBe('alpha')
  })

  it('falls back and warns when file has malformed JSON', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(path.join(root, PROFILE_FILE_NAME), '{ not valid json')
    expect(resolveInitialProfile(root, {})).toBe('default')
    expect(warn).toHaveBeenCalled()
  })

  it('falls back when file is a JSON array (not object)', () => {
    writeFileSync(path.join(root, PROFILE_FILE_NAME), JSON.stringify(['a', 'b']))
    expect(resolveInitialProfile(root, {})).toBe('default')
  })
})
