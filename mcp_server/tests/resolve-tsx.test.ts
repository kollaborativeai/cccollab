import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTsx } from '../src/resolve-tsx.js'

function plantFakeTsx(modulesRoot: string): string {
  const pkgDir = join(modulesRoot, 'node_modules', 'tsx')
  const distDir = join(pkgDir, 'dist')
  mkdirSync(distDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: 'tsx',
      version: '0.0.0-fake',
      type: 'module',
      exports: { './cli': './dist/cli.mjs' },
    }),
  )
  const cliPath = join(distDir, 'cli.mjs')
  writeFileSync(cliPath, '// fake tsx cli\n')
  return cliPath
}

describe('resolveTsx', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cccollab-resolve-tsx-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds tsx in the starting directory', () => {
    const cliPath = plantFakeTsx(root)
    expect(resolveTsx(root)).toBe(cliPath)
  })

  it('walks up ancestors to find tsx (hoisted workspace case)', () => {
    const cliPath = plantFakeTsx(root)
    const workspace = join(root, 'mcp_server', 'src')
    mkdirSync(workspace, { recursive: true })
    expect(resolveTsx(workspace)).toBe(cliPath)
  })

  it('returns null when no ancestor contains a tsx package', () => {
    const deep = join(root, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    expect(resolveTsx(deep)).toBeNull()
  })
})
