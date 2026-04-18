import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveInitialIdentity, IDENTITY_FILE_NAME } from '../src/initial-identity.js'

describe('resolveInitialIdentity', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'slack-collab-identity-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns empty when neither env nor file is present', () => {
    expect(resolveInitialIdentity(root, {})).toEqual({})
  })

  it('reads name and objective from env vars', () => {
    const env = { SLACK_COLLAB_NAME: 'architect', SLACK_COLLAB_OBJECTIVE: 'Design auth flow' }
    expect(resolveInitialIdentity(root, env)).toEqual({
      name: 'architect',
      objective: 'Design auth flow',
    })
  })

  it('trims whitespace and treats empty env as unset', () => {
    const env = { SLACK_COLLAB_NAME: '  architect  ', SLACK_COLLAB_OBJECTIVE: '   ' }
    expect(resolveInitialIdentity(root, env)).toEqual({ name: 'architect' })
  })

  it('falls back to .slack-collab.json at cwd when env is empty', () => {
    writeFileSync(
      path.join(root, IDENTITY_FILE_NAME),
      JSON.stringify({ name: 'platform-reviewer', objective: 'Review PRs' }),
    )
    expect(resolveInitialIdentity(root, {})).toEqual({
      name: 'platform-reviewer',
      objective: 'Review PRs',
    })
  })

  it('walks up parent directories to find .slack-collab.json', () => {
    writeFileSync(path.join(root, IDENTITY_FILE_NAME), JSON.stringify({ name: 'static-name' }))
    const nested = path.join(root, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    expect(resolveInitialIdentity(nested, {})).toEqual({ name: 'static-name' })
  })

  it('env takes precedence over file', () => {
    writeFileSync(
      path.join(root, IDENTITY_FILE_NAME),
      JSON.stringify({ name: 'static', objective: 'static-obj' }),
    )
    expect(
      resolveInitialIdentity(root, { SLACK_COLLAB_NAME: 'dynamic' }),
    ).toEqual({ name: 'dynamic' })
  })

  it('env objective alone is also accepted', () => {
    expect(
      resolveInitialIdentity(root, { SLACK_COLLAB_OBJECTIVE: 'Implement widget' }),
    ).toEqual({ objective: 'Implement widget' })
  })

  it('ignores malformed JSON and continues', () => {
    writeFileSync(path.join(root, IDENTITY_FILE_NAME), '{ not valid json')
    expect(resolveInitialIdentity(root, {})).toEqual({})
  })

  it('ignores non-object JSON (array, string)', () => {
    writeFileSync(path.join(root, IDENTITY_FILE_NAME), JSON.stringify(['a', 'b']))
    expect(resolveInitialIdentity(root, {})).toEqual({})
  })

  it('returns empty when file exists but has no recognized fields', () => {
    writeFileSync(path.join(root, IDENTITY_FILE_NAME), JSON.stringify({ unrelated: 'x' }))
    expect(resolveInitialIdentity(root, {})).toEqual({})
  })

  it('trims whitespace in file values', () => {
    writeFileSync(
      path.join(root, IDENTITY_FILE_NAME),
      JSON.stringify({ name: '  spaced  ', objective: '\n\tpad\n' }),
    )
    expect(resolveInitialIdentity(root, {})).toEqual({
      name: 'spaced',
      objective: 'pad',
    })
  })
})
