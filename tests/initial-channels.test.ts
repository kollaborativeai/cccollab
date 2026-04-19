import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveInitialChannels, CHANNELS_FILE_NAME } from '../src/initial-channels.js'

describe('resolveInitialChannels', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cccollab-channels-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('returns fallback default channel when neither env nor file is present', () => {
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['default'],
      source: 'fallback',
    })
  })

  it('parses CCCOLLAB_DEFAULT_CHANNELS CSV', () => {
    expect(resolveInitialChannels(root, { CCCOLLAB_DEFAULT_CHANNELS: 'foo,bar' })).toEqual({
      channels: ['foo', 'bar'],
      source: 'env',
    })
  })

  it('trims whitespace and lowercases env channels', () => {
    expect(resolveInitialChannels(root, { CCCOLLAB_DEFAULT_CHANNELS: ' Foo , BAR ' })).toEqual({
      channels: ['foo', 'bar'],
      source: 'env',
    })
  })

  it('treats empty env string as explicit zero channels', () => {
    expect(resolveInitialChannels(root, { CCCOLLAB_DEFAULT_CHANNELS: '' })).toEqual({
      channels: [],
      source: 'env',
    })
  })

  it('treats env with only whitespace/commas as explicit zero channels', () => {
    expect(resolveInitialChannels(root, { CCCOLLAB_DEFAULT_CHANNELS: ' , , ' })).toEqual({
      channels: [],
      source: 'env',
    })
  })

  it('dedupes env channels after normalization', () => {
    expect(resolveInitialChannels(root, { CCCOLLAB_DEFAULT_CHANNELS: 'a,a,A' })).toEqual({
      channels: ['a'],
      source: 'env',
    })
  })

  it('env takes precedence over file', () => {
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ default_channels: ['from-file'] }))
    expect(resolveInitialChannels(root, { CCCOLLAB_DEFAULT_CHANNELS: 'from-env' })).toEqual({
      channels: ['from-env'],
      source: 'env',
    })
  })

  it('reads default_channels from .cccollab.json when env is unset', () => {
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ default_channels: ['a', 'b'] }))
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['a', 'b'],
      source: 'cccollab.json',
    })
  })

  it('treats empty array in file as explicit zero channels', () => {
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ default_channels: [] }))
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: [],
      source: 'cccollab.json',
    })
  })

  it('falls back when file lacks default_channels key', () => {
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ name: 'only-name' }))
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['default'],
      source: 'fallback',
    })
  })

  it('falls back and warns when default_channels is not an array', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ default_channels: 'not-an-array' }))
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['default'],
      source: 'fallback',
    })
    expect(warn).toHaveBeenCalled()
  })

  it('falls back and warns when default_channels contains non-string element', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ default_channels: [123, 'ok'] }))
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['default'],
      source: 'fallback',
    })
    expect(warn).toHaveBeenCalled()
  })

  it('walks up parent directories to find .cccollab.json', () => {
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ default_channels: ['alpha'] }))
    const nested = path.join(root, 'a', 'b', 'c')
    mkdirSync(nested, { recursive: true })
    expect(resolveInitialChannels(nested, {})).toEqual({
      channels: ['alpha'],
      source: 'cccollab.json',
    })
  })

  it('falls back and warns when file has malformed JSON', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), '{ not valid json')
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['default'],
      source: 'fallback',
    })
    expect(warn).toHaveBeenCalled()
  })

  it('falls back when file is a JSON array (not object)', () => {
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify(['a', 'b']))
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['default'],
      source: 'fallback',
    })
  })

  it('normalizes file channels to lowercase and dedupes', () => {
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ default_channels: ['Foo', ' BAR ', 'foo'] }))
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['foo', 'bar'],
      source: 'cccollab.json',
    })
  })

  it('filters empty strings from file after trimming', () => {
    writeFileSync(path.join(root, CHANNELS_FILE_NAME), JSON.stringify({ default_channels: ['a', '   ', ''] }))
    expect(resolveInitialChannels(root, {})).toEqual({
      channels: ['a'],
      source: 'cccollab.json',
    })
  })
})
