#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

// DIR is the directory that owns this launcher: the package root when
// installed from npm (so dist/server.js exists), or mcp_server/ during dev
// (so src/server.ts exists).
const DIR = resolve(here, '..')
const srcEntry = join(DIR, 'src', 'server.ts')
const distEntry = join(DIR, 'dist', 'server.js')

function runChild(child) {
  child.on('exit', (code) => process.exit(code ?? 1))
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try {
        child.kill(sig)
      } catch {}
    })
  }
}

if (existsSync(srcEntry)) {
  let tsxCli = null
  try {
    tsxCli = require.resolve('tsx/cli')
  } catch {}
  if (tsxCli) {
    runChild(spawn(process.execPath, [tsxCli, srcEntry, ...process.argv.slice(2)], { stdio: 'inherit' }))
  } else if (existsSync(distEntry)) {
    await import(pathToFileURL(distEntry).href)
  } else {
    console.error('cccollab: src/server.ts present but tsx not installed, and no dist/server.js')
    process.exit(1)
  }
} else if (existsSync(distEntry)) {
  await import(pathToFileURL(distEntry).href)
} else {
  console.error('cccollab: no runnable target (expected src/server.ts + tsx, or dist/server.js)')
  process.exit(1)
}
