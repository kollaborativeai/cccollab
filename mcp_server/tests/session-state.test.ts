import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Route the test through a private HOME so it doesn't trample the real
// `~/.cccollab`. `os.homedir()` on Node honours `process.env.HOME` on
// Linux / macOS; on Windows it uses USERPROFILE, which we set too. The
// dynamic import below must come after this, because the path constants
// are resolved at module load.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'cccollab-session-state-test-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME

const { saveSessionState, loadSessionState, pruneStaleSessionStates, sessionStateFile, SESSION_STATE_VERSION } =
  await import('../src/session-state.js')
type SessionState = import('../src/session-state.js').SessionState
const { CCCOLLAB_SESSIONS_DIR } = await import('../src/constants.js')

function stateFor(sessionId: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    version: SESSION_STATE_VERSION,
    sessionId,
    channels: [{ name: 'dev', location: 'local', source: 'manual' as const }],
    topics: [{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }],
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('session-state store (KAI-415)', () => {
  beforeEach(() => {
    rmSync(CCCOLLAB_SESSIONS_DIR, { recursive: true, force: true })
  })
  afterAll(() => {
    rmSync(TMP_HOME, { recursive: true, force: true })
  })

  describe('round-trip', () => {
    it('restores the channels and topics a session had joined', () => {
      saveSessionState(stateFor('uuid-a'))
      const loaded = loadSessionState('uuid-a')
      expect(loaded?.channels).toEqual([{ name: 'dev', location: 'local', source: 'manual' }])
      expect(loaded?.topics).toEqual([{ id: 'topic-1', name: 'Auth', channel: 'dev', location: 'local' }])
    })

    it('restores the active channel and active topic pointers', () => {
      saveSessionState(
        stateFor('uuid-a', { activeChannel: { name: 'dev', location: 'local' }, activeTopic: 'topic-1' }),
      )
      const loaded = loadSessionState('uuid-a')
      expect(loaded?.activeChannel).toEqual({ name: 'dev', location: 'local' })
      expect(loaded?.activeTopic).toBe('topic-1')
    })

    it('returns null for a session that has never been persisted (fresh session is a no-op)', () => {
      expect(loadSessionState('never-seen')).toBeNull()
    })

    it('overwrites rather than appends, so a restart does not grow the file unboundedly', () => {
      saveSessionState(stateFor('uuid-a'))
      saveSessionState(stateFor('uuid-a', { channels: [{ name: 'ops', location: 'local', source: 'manual' }] }))
      expect(loadSessionState('uuid-a')?.channels).toEqual([{ name: 'ops', location: 'local', source: 'manual' }])
    })
  })

  describe('isolation between sessions (HAZARD 2)', () => {
    it('two sessionIds get two different files - neither can clobber the other', () => {
      expect(sessionStateFile('uuid-a')).not.toBe(sessionStateFile('uuid-b'))
    })

    it("each session loads back its OWN subscriptions, never its neighbour's", () => {
      saveSessionState(stateFor('uuid-a', { channels: [{ name: 'alpha', location: 'local', source: 'manual' }] }))
      saveSessionState(stateFor('uuid-b', { channels: [{ name: 'beta', location: 'local', source: 'manual' }] }))

      expect(loadSessionState('uuid-a')?.channels.map((c) => c.name)).toEqual(['alpha'])
      expect(loadSessionState('uuid-b')?.channels.map((c) => c.name)).toEqual(['beta'])
    })
  })

  describe('sessionId is a trust boundary (it lands in a file path)', () => {
    // The id arrives from the environment. It is a UUID in practice, but
    // "in practice" is not a security control: it must not be able to
    // address a file outside the sessions dir.
    const hostile = ['../../../etc/cccollab-pwned', '..', '.', 'a/b', 'a\\b', '', '   ', 'uuid\0.json', 'a:b']
    for (const id of hostile) {
      it(`rejects ${JSON.stringify(id)} instead of letting it address a path`, () => {
        expect(() => sessionStateFile(id)).toThrow(/session id/i)
      })
    }

    it('does not write outside the sessions dir when given a traversing id', () => {
      expect(() => saveSessionState(stateFor('../../pwned'))).toThrow(/session id/i)
      expect(existsSync(join(TMP_HOME, 'pwned.json'))).toBe(false)
    })

    // NOT a throw. `loadSessionState` runs at the top of startup, before
    // the server exists, so a throw here escapes to `main().catch(exit 1)`
    // and a hostile env var becomes a plugin that will not start at all —
    // the exact bug class KAI-368 fixed. A bad id costs persistence, never
    // the session.
    it('loads nothing through a traversing id instead of taking startup down', () => {
      expect(loadSessionState('../../../etc/passwd')).toBeNull()
      expect(loadSessionState('..')).toBeNull()
      expect(loadSessionState('a/b')).toBeNull()
    })

    it('accepts a real Claude Code session UUID', () => {
      const uuid = '3f1a2b4c-5d6e-7f80-9a1b-2c3d4e5f6071'
      expect(sessionStateFile(uuid)).toBe(join(CCCOLLAB_SESSIONS_DIR, `${uuid}.json`))
    })
  })

  describe('on-disk hygiene', () => {
    it('writes the state file at mode 0600 - it names what this machine is working on', () => {
      saveSessionState(stateFor('uuid-a'))
      if (process.platform !== 'win32') {
        expect(statSync(sessionStateFile('uuid-a')).mode & 0o777).toBe(0o600)
      }
    })

    it('ignores a corrupt state file rather than crashing the server at boot', () => {
      saveSessionState(stateFor('uuid-a'))
      writeFileSync(sessionStateFile('uuid-a'), '{ this is not json', { mode: 0o600 })
      expect(loadSessionState('uuid-a')).toBeNull()
    })

    it('ignores a state file written by a future/foreign schema instead of misreading it', () => {
      saveSessionState(stateFor('uuid-a'))
      writeFileSync(sessionStateFile('uuid-a'), JSON.stringify({ version: 99, sessionId: 'uuid-a' }), { mode: 0o600 })
      expect(loadSessionState('uuid-a')).toBeNull()
    })

    it('stamps the schema version so a future format change can be detected', () => {
      saveSessionState(stateFor('uuid-a'))
      expect(JSON.parse(readFileSync(sessionStateFile('uuid-a'), 'utf-8')).version).toBe(SESSION_STATE_VERSION)
    })
  })

  describe('pruning stale session files', () => {
    function plantWithAge(sessionId: string, ageMs: number, now: number): void {
      saveSessionState(stateFor(sessionId))
      const seconds = (now - ageMs) / 1000
      utimesSync(sessionStateFile(sessionId), seconds, seconds)
    }

    it('prunes a file older than the retention window', () => {
      const now = Date.now()
      plantWithAge('uuid-old', 31 * DAY_MS, now)
      pruneStaleSessionStates({ now })
      expect(existsSync(sessionStateFile('uuid-old'))).toBe(false)
    })

    it('keeps a file inside the retention window', () => {
      const now = Date.now()
      plantWithAge('uuid-recent', 29 * DAY_MS, now)
      pruneStaleSessionStates({ now })
      expect(existsSync(sessionStateFile('uuid-recent'))).toBe(true)
    })

    it('never prunes the current session, however ancient its file looks', () => {
      // A long-lived session whose file predates the window is still live;
      // reaping it would delete the very state we are about to restore.
      const now = Date.now()
      plantWithAge('uuid-current', 400 * DAY_MS, now)
      pruneStaleSessionStates({ now, keepSessionId: 'uuid-current' })
      expect(existsSync(sessionStateFile('uuid-current'))).toBe(true)
    })

    it('prunes only the stale files, leaving the fresh ones alone', () => {
      const now = Date.now()
      plantWithAge('uuid-old', 90 * DAY_MS, now)
      plantWithAge('uuid-fresh', 1 * DAY_MS, now)
      pruneStaleSessionStates({ now })
      expect(existsSync(sessionStateFile('uuid-old'))).toBe(false)
      expect(existsSync(sessionStateFile('uuid-fresh'))).toBe(true)
    })

    it('never throws when the sessions dir does not exist yet (first ever run)', () => {
      rmSync(CCCOLLAB_SESSIONS_DIR, { recursive: true, force: true })
      expect(() => pruneStaleSessionStates({ now: Date.now() })).not.toThrow()
    })

    it('leaves unrelated files in the dir alone', () => {
      const now = Date.now()
      saveSessionState(stateFor('uuid-a'))
      const strayPath = join(CCCOLLAB_SESSIONS_DIR, 'notes.txt')
      writeFileSync(strayPath, 'do not delete me')
      const ancient = (now - 400 * DAY_MS) / 1000
      utimesSync(strayPath, ancient, ancient)
      pruneStaleSessionStates({ now })
      expect(existsSync(strayPath)).toBe(true)
    })

    it('does not leave lock or temp files behind after a save', () => {
      saveSessionState(stateFor('uuid-a'))
      const leftovers = readdirSync(CCCOLLAB_SESSIONS_DIR).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp'))
      expect(leftovers).toEqual([])
    })
  })
})
