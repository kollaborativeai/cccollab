#!/usr/bin/env node
/**
 * Drive the cccollab MCP server over stdio for the KAI-415 hand test.
 *
 * Exists so the hand test is RUNNABLE rather than merely assertable: every
 * claim in KAI-415-session-restore.md is something this script prints.
 *
 * Usage, from mcp_server/:
 *   HOME=/tmp/ht node ../docs/hand-tests/kai-415-drive.mjs <sessionId> [tool|jsonArgs ...]
 *
 * Set HOME to a scratch dir. State lands in $HOME/.cccollab/sessions/, so an
 * isolated HOME keeps the test away from your real subscriptions.
 */
import { spawn } from 'node:child_process'

const [, , sessionId, ...calls] = process.argv
if (sessionId === undefined) {
  console.error('usage: kai-415-drive.mjs <sessionId> [tool|jsonArgs ...]')
  process.exit(2)
}

const child = spawn('npx', ['tsx', 'src/server.ts'], {
  env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
  stdio: ['pipe', 'pipe', 'pipe'],
})
// The restore report and the degradation warnings both land on stderr, and
// they are the only evidence for some of the checks - never swallow them.
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d))

let buf = ''
const waiters = new Map()
child.stdout.on('data', (d) => {
  buf += d
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines.filter(Boolean)) {
    try {
      const msg = JSON.parse(line)
      if (waiters.has(msg.id)) {
        waiters.get(msg.id)(msg)
        waiters.delete(msg.id)
      }
    } catch {
      /* not a JSON-RPC frame */
    }
  }
})

const rpc = (id, method, params) =>
  new Promise((resolve) => {
    waiters.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })

const init = await rpc(1, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'kai-415-hand-test', version: '1' },
})
// "did it answer at all" IS the check for the malformed-session-id case.
console.log('MCP initialize:', init.result ? 'OK' : 'FAILED')
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

// Sequential, never batched: tools/call is async server-side, so firing
// start_topic before join_channel has resolved fails on a race, not on a bug.
let id = 10
for (const call of calls) {
  const [name, args] = call.split('|')
  const msg = await rpc(id++, 'tools/call', { name, arguments: args ? JSON.parse(args) : {} })
  console.log(`--- ${name}\n` + (msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error)))
}

child.kill()
process.exit(0)
