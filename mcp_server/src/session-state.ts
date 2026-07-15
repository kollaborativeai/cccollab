import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import * as z from 'zod'

import { CCCOLLAB_SESSIONS_DIR } from './constants.js'
import { writeFileAtomic } from './file-lock.js'

/**
 * Persisted per-session subscription state (KAI-415).
 *
 * The MCP server holds "which channels/topics am I in" purely in memory
 * (`ActiveContext`). When the server restarts — a plugin update, a crash,
 * a config reload — that memory is gone, but the BROKER still has the
 * session in its topics. The result is a session that looks joined from
 * the outside while `broker-event-listener` drops every inbound topic
 * message on the floor because `context.isTopicJoined()` is false. The
 * user sees silence and has no way to tell it apart from "nobody said
 * anything". This module is the disk half of the fix: mirror the context
 * to disk on every mutation, read it back at boot.
 *
 * One file per session (`<sessionId>.json`), never one shared file:
 * sessions on a machine restart independently and concurrently, and a
 * shared file would make every write a read-modify-write race where the
 * loser's subscriptions vanish.
 */
export const SESSION_STATE_VERSION = 1

/** How long a session file outlives its last write before boot-time
 *  pruning reaps it. Deliberately a plain constant and not a configurable
 *  policy: the file is small, the cost of keeping it is ~nothing, and the
 *  only real goal is that `~/.cccollab/sessions` doesn't grow forever on
 *  a machine that has run thousands of sessions. */
const STALE_SESSION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The `sessionId` originates outside this process (Claude Code's
 * environment) and is interpolated straight into a file path, so it is a
 * trust boundary: an id of `../../.ssh/authorized_keys` must not be able
 * to address a file outside the sessions dir. We allowlist rather than
 * blocklist — the real ids are UUIDs, so anything outside
 * `[A-Za-z0-9._-]` has no legitimate reason to appear, and an allowlist
 * cannot be outflanked by an encoding trick the way a `..`-blocklist can.
 *
 * Requiring the FIRST character to be alphanumeric is what rules out `.`
 * and `..` (and any `..`-prefixed traversal) without a separate special
 * case, and also rules out the empty string.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const SessionStateSchema = z.object({
  version: z.literal(SESSION_STATE_VERSION),
  sessionId: z.string(),
  channels: z.array(
    z.object({
      name: z.string(),
      location: z.string(),
      source: z.string(),
    }),
  ),
  topics: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      channel: z.string(),
      location: z.string(),
    }),
  ),
  activeChannel: z.object({ name: z.string(), location: z.string() }).optional(),
  activeTopic: z.string().optional(),
  updatedAt: z.number(),
})

export type SessionState = z.infer<typeof SessionStateSchema>
export type PersistedChannel = SessionState['channels'][number]
export type PersistedTopic = SessionState['topics'][number]

/**
 * Absolute path of a session's state file.
 *
 * Throws on an id that could escape the sessions dir. Throwing (rather
 * than sanitising to some "safe" fallback) is deliberate: a fallback
 * would silently key two different sessions to one file, which is the
 * cross-contamination this design exists to prevent. Callers on the
 * startup path treat a throw as "no persistence for this session" and
 * carry on — the floor is today's behaviour, never a crash.
 */
export function sessionStateFile(sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`cccollab: refusing to use ${JSON.stringify(sessionId)} as a session id in a file path`)
  }
  return join(CCCOLLAB_SESSIONS_DIR, `${sessionId}.json`)
}

/**
 * Write a session's state, replacing any previous copy. Mode 0600: the
 * file names the channels and topics this machine is working in.
 *
 * Deliberately NOT locked, unlike `config/save.ts` which shares this
 * directory. That file needs a lock because its write is a
 * read-modify-write (merge one location's auth into a doc holding all of
 * them), so a concurrent writer can lose an update. This one is a whole
 * snapshot serialised from memory: it reads nothing, so there is no
 * update to lose, and last-write-wins is the correct outcome — the last
 * writer is the one whose in-memory context is current. `writeFileAtomic`
 * already rules out the only other hazard (a reader seeing a half-written
 * file) via rename. A lock here would be pure ceremony.
 *
 * ponytail: two writers means two processes on ONE session id — a
 * restarting server briefly overlapping its predecessor. Both write
 * complete snapshots, so the loser of that race costs nothing.
 */
export function saveSessionState(state: SessionState): void {
  const file = sessionStateFile(state.sessionId)
  mkdirSync(CCCOLLAB_SESSIONS_DIR, { recursive: true })
  writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n', 0o600)
}

/**
 * Read a session's persisted state, or `null` when there is nothing
 * usable there.
 *
 * Absent (a fresh session), corrupt, or written by a schema this build
 * doesn't understand all collapse to `null` — i.e. "restore nothing",
 * which degrades to exactly today's behaviour. A bad file must never
 * take the server's startup down with it; that would turn a cosmetic
 * persistence miss into a session the user cannot start at all.
 */
export function loadSessionState(sessionId: string): SessionState | null {
  const file = sessionStateFile(sessionId)
  if (!existsSync(file)) return null
  try {
    const parsed = SessionStateSchema.safeParse(JSON.parse(readFileSync(file, 'utf-8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Delete session files whose last write is older than the retention
 * window. Called once at boot; there is no scheduler and no cron, because
 * a process that starts is the only thing that makes the directory grow.
 *
 * `keepSessionId` (the current session) is never pruned regardless of
 * age: a long-lived session that has not re-subscribed in a month still
 * has live state we are about to restore.
 *
 * Best-effort throughout — a file we cannot stat or unlink (permissions,
 * a peer pruning concurrently) is skipped. Pruning is housekeeping and
 * must never block or fail startup.
 */
export function pruneStaleSessionStates(opts: { now: number; keepSessionId?: string }): void {
  let entries: string[]
  try {
    entries = readdirSync(CCCOLLAB_SESSIONS_DIR)
  } catch {
    // No sessions dir yet (first ever run), or unreadable. Nothing to do.
    return
  }
  for (const entry of entries) {
    // Only ever consider files we wrote. A stray `notes.txt` or a peer's
    // `.lock` is not ours to delete.
    if (!entry.endsWith('.json')) continue
    if (opts.keepSessionId !== undefined && entry === `${opts.keepSessionId}.json`) continue
    const file = join(CCCOLLAB_SESSIONS_DIR, entry)
    try {
      if (opts.now - statSync(file).mtimeMs <= STALE_SESSION_MS) continue
      unlinkSync(file)
    } catch {
      /* unreadable / already gone / not ours — leave it alone */
    }
  }
}
