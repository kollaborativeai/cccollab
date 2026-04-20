import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTsx } from '../src/resolve-tsx.js'

describe('resolveTsx', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cccollab-resolve-tsx-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds tsx in the starting directory', () => {
    const bin = join(root, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    const tsxPath = join(bin, 'tsx')
    writeFileSync(tsxPath, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(tsxPath, 0o755)
    expect(resolveTsx(root)).toBe(tsxPath)
  })

  it('walks up ancestors to find tsx (hoisted workspace case)', () => {
    const workspace = join(root, 'mcp_server', 'src')
    mkdirSync(workspace, { recursive: true })
    const bin = join(root, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    const tsxPath = join(bin, 'tsx')
    writeFileSync(tsxPath, '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(tsxPath, 0o755)
    expect(resolveTsx(workspace)).toBe(tsxPath)
  })

  it('returns null when no ancestor contains node_modules/.bin/tsx', () => {
    const deep = join(root, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    expect(resolveTsx(deep)).toBeNull()
  })
})
