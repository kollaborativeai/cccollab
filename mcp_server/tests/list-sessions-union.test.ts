import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConvexClient } from 'convex/browser'
import { getFunctionName } from 'convex/server'

import { ActiveContext } from '../src/context.js'
import { SessionManager } from '../src/session.js'
import { resolveTsx } from '../src/resolve-tsx.js'
import { handleChannelTool } from '../src/tools/channels.js'
import { handleTopicTool } from '../src/tools/topics.js'
import { LocalTransport } from '../src/transport/local.js'
import { RemoteTransport } from '../src/transport/remote.js'
import { TransportRouter } from '../src/transport/router.js'

/**
 * KAI-516's repro, end to end: one process introduces itself at two
 * locations, joins `kai` locally and `product` remotely, then calls
 * `list_sessions`. Its Expected Result is *one* entry carrying both
 * memberships, each tagged with the location it came from.
 *
 * Everything below the tool call is real — a broker subprocess, a real
 * `LocalTransport` over HTTP, a real `RemoteTransport`, the real
 * `handleTopicTool`. Only the Convex wire is stubbed, and it is stubbed
 * to behave the way the deployed backend behaves, argument validation
 * included: a fake that accepts calls the real backend rejects is how a
 * fix ships as a silent no-op.
 *
 * Sibling coverage is transport-level (`tests/remote/transport.test.ts`,
 * `tests/transport/local.test.ts`) or fake-transport-level
 * (`tests/dual-transport.test.ts`); this is the only test that runs the
 * whole path the ticket describes.
 */

const PROFILE = `union-${process.pid}`
const RENDEZVOUS = join(homedir(), '.cccollab', 'run', `${PROFILE}.json`)

/** Convex `Id<'cccollabSessions'>` shapes — never UUIDs, so they can
 *  never collide with the ids the local broker's id-space would use. */
const OWN_REMOTE_ID = 'k5711aaaaaaaaaaaaaaaaaaaaaaaaaa'
const PEER_REMOTE_ID = 'k9922bbbbbbbbbbbbbbbbbbbbbbbbbb'

async function waitUntil<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return v
    await new Promise<void>((r) => setTimeout(r, 50))
  }
  throw new Error('waitUntil timeout')
}

/**
 * Convex stub modelling the two backend functions this path touches.
 *
 * `channels.listForUser` is declared `args: { sessionId: v.id('cccollabSessions') }`
 * and reads `cccollabSessionChannels` by that id, so it is session-scoped,
 * not merely identity-scoped: called without the id, Convex rejects it with
 * an ArgumentValidationError. The stub rejects it too, so a caller that
 * stops passing the id fails here instead of silently reporting no
 * memberships.
 */
function makeConvexStub(): ConvexClient {
  const joinedChannels: string[] = []

  const requireSessionId = (fnName: string, args: Record<string, unknown>): void => {
    if (args.sessionId !== OWN_REMOTE_ID) {
      throw new Error(`ArgumentValidationError: ${fnName} requires sessionId; got ${JSON.stringify(args)}`)
    }
  }

  const stub = {
    query: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
      if (name === 'cccollab/topics:listJoinedForSession') return []
      if (name === 'cccollab/sessions:listByChannel') {
        requireSessionId(name, args)
        // The backend never denormalizes memberships onto these rows —
        // that omission is the bug KAI-516 was filed over.
        return [
          { _id: OWN_REMOTE_ID, sessionName: 'product-manager', createdAt: 1_700_000_000_000 },
          { _id: PEER_REMOTE_ID, sessionName: 'reviewer', createdAt: 1_700_000_000_000 },
        ]
      }
      if (name === 'cccollab/channels:listForUser') {
        requireSessionId(name, args)
        return joinedChannels.map((channel) => ({ name: channel }))
      }
      throw new Error(`unexpected query: ${name}`)
    }),
    mutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0])
      if (name === 'cccollab/sessions:introduce') return OWN_REMOTE_ID
      if (name === 'cccollab/channels:join') {
        requireSessionId(name, args)
        joinedChannels.push(String(args.channel))
        return { channelId: `chan_${String(args.channel)}` }
      }
      return undefined
    }),
    onUpdate: vi.fn(() => () => {}),
    setAuth: vi.fn(),
  }
  return stub as unknown as ConvexClient
}

describe('KAI-516: list_sessions across a real local broker and a real remote transport', () => {
  let broker: ChildProcess
  let port: number

  beforeAll(async () => {
    const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
    const brokerPath = fileURLToPath(new URL('../src/broker.ts', import.meta.url))
    broker = spawn(process.execPath, [tsxCli, brokerPath], {
      env: { ...process.env, CCCOLLAB_PROFILE: PROFILE },
      stdio: 'ignore',
    })
    await waitUntil(() => (existsSync(RENDEZVOUS) ? true : null), 10_000)
    const rendezvous = JSON.parse(readFileSync(RENDEZVOUS, 'utf-8')) as { port: number }
    port = rendezvous.port
    await waitUntil(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        return res.ok ? true : null
      } catch {
        return null
      }
    }, 10_000)
  }, 20_000)

  afterAll(async () => {
    if (broker && !broker.killed) {
      broker.kill('SIGTERM')
      await new Promise<void>((r) => setTimeout(r, 200))
      try {
        unlinkSync(RENDEZVOUS)
      } catch {
        /* ignore */
      }
    }
  })

  it("reports the caller as one session listing both locations' channels", async () => {
    const local = new LocalTransport(port)
    const remote = new RemoteTransport({ client: makeConvexStub(), log: () => {} })
    const session = new SessionManager({ username: 'tester', cwd: '/tmp/proj' })
    session.setName('product-manager')
    const deps = { session, context: new ActiveContext(), router: new TransportRouter([local, remote]) }

    try {
      await local.introduce({ sessionName: 'product-manager' })
      await remote.introduce({ sessionName: 'product-manager' })
      await handleChannelTool('join_channel', { name: 'kai', location: 'local' }, deps)
      await handleChannelTool('join_channel', { name: 'product', location: 'remote' }, deps)

      const result = JSON.parse(await handleTopicTool('list_sessions', {}, deps)) as Array<{
        name: string
        channels: Array<{ name: string; location: string }>
      }>

      // The ticket's Expected Result, verbatim: one entry for us, holding
      // what we hold at each location — not two peers each holding half.
      expect(result.filter((s) => s.name === 'product-manager')).toHaveLength(1)
      expect(result.map((s) => ({ name: s.name, channels: s.channels }))).toEqual([
        {
          name: 'product-manager',
          channels: [
            { name: 'kai', location: 'local' },
            { name: 'product', location: 'remote' },
          ],
        },
        { name: 'reviewer', channels: [] },
      ])
    } finally {
      await remote.shutdown()
    }
  })
})
