import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Private HOME so the state files land in a temp dir, not the real
// ~/.cccollab. Must precede the dynamic imports: the path constants are
// resolved at module load. The BROKER is deliberately left on the real
// HOME (its rendezvous path is computed in a child process before this
// takes effect), hence the separate RENDEZVOUS path below.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-restore-e2e-'))
const REAL_HOME = homedir()
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { resolveTsx } = await import('../src/resolve-tsx.js')
const { SessionManager } = await import('../src/session.js')
const { MessageBus } = await import('../src/message-bus.js')
const { ActiveContext } = await import('../src/context.js')
const { LocalTransport } = await import('../src/transport/local.js')
const { TransportRouter } = await import('../src/transport/router.js')
const { handleIdentityTool } = await import('../src/tools/identity.js')
const { handleChannelTool } = await import('../src/tools/channels.js')
const { handleTopicTool } = await import('../src/tools/topics.js')
const { saveSessionState, loadSessionState } = await import('../src/session-state.js')
const { restoreSubscriptions, snapshotSessionState } = await import('../src/session-persistence.js')

const PROFILE = `restore-e2e-${process.pid}`
const RENDEZVOUS = join(REAL_HOME, '.cccollab', 'run', `${PROFILE}.json`)
const SESSION_ID = `e2e-${process.pid}`

async function waitUntil<T>(fn: () => T | null | Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await fn()
    if (v) return v
    await new Promise<void>((r) => setTimeout(r, 50))
  }
  throw new Error('waitUntil timeout')
}

/**
 * A session process. Building a second one with the same `sessionId` and a
 * FRESH ActiveContext is exactly what a restart is: the broker still holds
 * the memberships, the in-memory context is empty.
 */
function makeSession(brokerPort: number, sessionId: string) {
  const session = new SessionManager({ username: 'tester', cwd: '/projects/e2e' })
  const messageBus = new MessageBus({ notification: vi.fn().mockResolvedValue(undefined) } as never)
  messageBus.push = vi.fn(async () => {})
  const context = new ActiveContext(() => {
    saveSessionState(snapshotSessionState(sessionId, context))
  })
  const transport = new LocalTransport(brokerPort)
  const router = new TransportRouter([transport])
  return { session, context, router, deps: { session, context, router }, transport }
}

describe('KAI-415 end-to-end: subscriptions survive a restart (real broker)', () => {
  let broker: ChildProcess
  let brokerPort: number

  beforeAll(async () => {
    const tsxCli = resolveTsx(dirname(fileURLToPath(import.meta.url)))
    if (!tsxCli) throw new Error('tsx CLI module not resolvable from tests dir')
    const brokerPath = fileURLToPath(new URL('../src/broker.ts', import.meta.url))
    broker = spawn(process.execPath, [tsxCli, brokerPath], {
      env: { ...process.env, HOME: REAL_HOME, CCCOLLAB_PROFILE: PROFILE },
      stdio: 'ignore',
    })
    await waitUntil(() => (existsSync(RENDEZVOUS) ? true : null))
    brokerPort = (JSON.parse(readFileSync(RENDEZVOUS, 'utf-8')) as { port: number }).port
    await waitUntil(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${brokerPort}/health`)).ok ? true : null
      } catch {
        return null
      }
    })
  }, 30_000)

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
    rmSync(TMP_HOME, { recursive: true, force: true })
  })

  it('a restarted session rejoins the channel and topic it had - and skips the one that was archived', async () => {
    // ── Life one: join a channel, start two topics.
    const first = makeSession(brokerPort, SESSION_ID)
    await handleIdentityTool('introduce', { name: 'e2e-worker' }, first.deps)
    await handleChannelTool('join_channel', { name: 'e2e-dev' }, first.deps)
    await handleTopicTool('start_topic', { topic: 'Survives' }, first.deps)
    await handleTopicTool('start_topic', { topic: 'GetsArchived' }, first.deps)

    const survives = first.context.findJoinedTopic('Survives')
    const archived = first.context.findJoinedTopic('GetsArchived')
    expect(survives).not.toBeNull()
    expect(archived).not.toBeNull()

    // The onChange hook should already have mirrored all of that to disk,
    // with no explicit save anywhere in this test.
    const persisted = loadSessionState(SESSION_ID)
    expect(persisted?.channels.map((c) => c.name)).toEqual(['e2e-dev'])
    expect(persisted?.topics.map((t) => t.name).sort()).toEqual(['GetsArchived', 'Survives'])

    // Archive one topic through the real tool, against the real broker.
    await handleTopicTool('archive_topic', { topic: archived!.threadTs }, first.deps)

    // ── The restart: brand-new context, same session id. Nothing is
    // carried over in memory - only what is on disk.
    const second = makeSession(brokerPort, SESSION_ID)
    await handleIdentityTool('introduce', { name: 'e2e-worker' }, second.deps)
    expect(second.context.getSubscribedChannels()).toEqual([])

    const saved = loadSessionState(SESSION_ID)
    expect(saved).not.toBeNull()
    const result = await restoreSubscriptions(saved!, {
      sessionName: 'e2e-worker',
      context: second.context,
      transportFor: () => second.transport,
    })

    // The channel is back.
    expect(second.context.isChannelSubscribed('e2e-dev', 'local')).toBe(true)
    expect(second.context.getChannelSource('e2e-dev', 'local')).toBe('restored')

    // The live topic is back...
    expect(second.context.isTopicJoined(survives!.threadTs)).toBe(true)
    // ...and the archived one stayed dead.
    expect(second.context.isTopicJoined(archived!.threadTs)).toBe(false)
    expect(result).toMatchObject({ channels: 1, topics: 1, skippedTopics: 1 })

    // And it was not resurrected on the broker either - the thing that
    // would betray a restore that "helpfully" recreated it.
    const topics = await second.transport.listTopics({ sessionName: 'e2e-worker', channel: 'e2e-dev' })
    const names = topics.filter((t) => t.state === 'active').map((t) => t.topic)
    expect(names).toContain('Survives')
    expect(names).not.toContain('GetsArchived')

    // The archived topic is also gone from the FILE, not just from memory.
    // Restore rebuilds context from what is live, and the hook writes that
    // context back - so a dead topic drops out on the next restart rather
    // than being retried forever.
    expect(loadSessionState(SESSION_ID)?.topics.map((t) => t.name)).toEqual(['Survives'])
  }, 30_000)

  it('a third restart still works - restore is idempotent, not a one-shot', async () => {
    // Guards the file rotting across generations: gen-2 wrote the file that
    // gen-3 now reads. If restore mangled its own output, this is where it
    // shows up.
    const third = makeSession(brokerPort, SESSION_ID)
    await handleIdentityTool('introduce', { name: 'e2e-worker' }, third.deps)
    const saved = loadSessionState(SESSION_ID)
    const result = await restoreSubscriptions(saved!, {
      sessionName: 'e2e-worker',
      context: third.context,
      transportFor: () => third.transport,
    })
    expect(result).toMatchObject({ channels: 1, topics: 1, skippedTopics: 0 })
    expect(third.context.getJoinedTopics().map((t) => t.topicName)).toEqual(['Survives'])
  }, 30_000)

  it('a genuinely new session (different id) restores nothing', async () => {
    const fresh = makeSession(brokerPort, `${SESSION_ID}-other`)
    await handleIdentityTool('introduce', { name: 'e2e-fresh' }, fresh.deps)
    expect(loadSessionState(`${SESSION_ID}-other`)).toBeNull()
    expect(fresh.context.getSubscribedChannels()).toEqual([])
  })
})
