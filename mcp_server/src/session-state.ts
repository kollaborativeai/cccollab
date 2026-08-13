import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
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
/** Must stay aligned with `isSafeSessionId` in `session.ts` (KAI-415 I3/I10). */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** ChannelSource values ActiveContext accepts (KAI-415 I10). */
const CHANNEL_SOURCES = ['manual', 'fallback', 'env', 'cccollab.json', 'restored'] as const

const SessionStateSchema = z
  .object({
    version: z.literal(SESSION_STATE_VERSION),
    sessionId: z.string().regex(SAFE_SESSION_ID),
    channels: z.array(
      z.object({
        name: z.string().min(1),
        location: z.string().min(1),
        source: z.enum(CHANNEL_SOURCES),
      }),
    ),
    topics: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        channel: z.string().min(1),
        location: z.string().min(1),
      }),
    ),
    activeChannel: z.object({ name: z.string().min(1), location: z.string().min(1) }).optional(),
    activeTopic: z.string().min(1).optional(),
    updatedAt: z.number(),
  })
  .superRefine((data, ctx) => {
    if (data.activeTopic !== undefined && !data.topics.some((t) => t.id === data.activeTopic)) {
      ctx.addIssue({
        code: 'custom',
        message: 'activeTopic must be one of topics[].id',
        path: ['activeTopic'],
      })
    }
    if (data.activeChannel !== undefined) {
      const ok = data.channels.some(
        (c) => c.name === data.activeChannel!.name && c.location === data.activeChannel!.location,
      )
      if (!ok) {
        ctx.addIssue({
          code: 'custom',
          message: 'activeChannel must match a channels[] entry',
          path: ['activeChannel'],
        })
      }
    }
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
 * cross-contamination this design exists to prevent. `loadSessionState`
 * — the one caller that runs on the startup path, before the server
 * exists — turns that throw into `null` so a hostile id costs the
 * session its persistence and nothing more.
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
 * update to lose. Last-write-wins is intentional (KAI-415 I11): two
 * processes on ONE session id (restart overlapping predecessor) both
 * write complete snapshots via `writeFileAtomic` (rename), so the reader
 * never sees a torn file — but the older process can still win the race
 * and leave a stale membership list. Accepting that is a product call;
 * do not invent a lock here without Samuel.
 */
export function saveSessionState(state: SessionState): void {
  const file = sessionStateFile(state.sessionId)
  // S1: dir mode 0700 so session filenames are not world-listable under a
  // typical 755 home; files themselves stay 0600.
  mkdirSync(CCCOLLAB_SESSIONS_DIR, { recursive: true, mode: 0o700 })
  try {
    chmodSync(CCCOLLAB_SESSIONS_DIR, 0o700)
  } catch {
    /* filesystems that reject chmod — leave the mode from mkdir */
  }
  writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n', 0o600)
}

/**
 * Read a session's persisted state, or `null` when there is nothing
 * usable there.
 *
 * Absent (a fresh session), corrupt, written by a schema this build
 * doesn't understand, or keyed by an id that cannot be a filename all
 * collapse to `null` — i.e. "restore nothing", which degrades to exactly
 * today's behaviour. A bad file or a bad id must never take the server's
 * startup down with it; that would turn a cosmetic persistence miss into
 * a session the user cannot start at all (cf. KAI-368, where an erroring
 * remote bricked the whole plugin).
 *
 * This is the only unguarded call on the startup path — it runs at
 * `server.ts:80`, before the context and before stdio is bound — so the
 * "never a crash" floor has to hold HERE, not at the call site.
 */
export function loadSessionState(sessionId: string): SessionState | null {
  let file: string
  try {
    file = sessionStateFile(sessionId)
  } catch (err) {
    // An id that cannot address a file has no file to load (I5: log once).
    console.error(
      `[cccollab] Ignoring unusable session state for ${JSON.stringify(sessionId)}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
  if (!existsSync(file)) return null
  try {
    // I8: refuse FIFO/symlink/dir so a same-UID mkfifo cannot hang startup
    // forever on readFileSync, and a symlink cannot redirect the read.
    const st = lstatSync(file)
    if (!st.isFile()) {
      console.error(`[cccollab] Ignoring unusable session state for ${sessionId}: not a regular file (${file})`)
      return null
    }
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    const parsed = SessionStateSchema.safeParse(raw)
    if (!parsed.success) {
      console.error(
        `[cccollab] Ignoring unusable session state for ${sessionId}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      )
      return null
    }
    // I10: body sessionId must match the path key (copied/hand-edited files).
    if (parsed.data.sessionId !== sessionId) {
      console.error(
        `[cccollab] Ignoring unusable session state for ${sessionId}: body sessionId ${JSON.stringify(parsed.data.sessionId)} does not match path key`,
      )
      return null
    }
    return parsed.data
  } catch (err) {
    console.error(
      `[cccollab] Ignoring unusable session state for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    )
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
    // S2: only reap session-shaped names we would ever write
    // (`<SAFE_SESSION_ID>.json`). A stray `notes.json` in this dir is not ours.
    if (!entry.endsWith('.json')) continue
    const base = entry.slice(0, -'.json'.length)
    if (!SAFE_SESSION_ID.test(base)) continue
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
