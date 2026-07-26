import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Cross-process lock + atomic write for files under `~/.cccollab`.
 *
 * Extracted from `config/save.ts` (KAI-415). `writeFileAtomic` is the
 * genuinely shared part: the session-state store needs the same
 * write-tmp-then-rename guarantee, and a second hand-rolled copy of it
 * next door is how the two quietly drift apart.
 *
 * The LOCK is a different story and has exactly one caller
 * (`config/save.ts`). Session state deliberately does not take it — see
 * `saveSessionState` for why a whole-snapshot write has nothing to lock.
 * The lock lives here rather than back in `save.ts` only because it and
 * the atomic write are two halves of one protocol for one directory;
 * splitting them across files buys nothing. It is parameterised by target
 * path so each protected file gets its own `<file>.lock` sibling.
 *
 * Semantics:
 *   - Lock file is a sibling of the target file (`<file>.lock`).
 *   - The holder writes its PID into the lock file as the body.
 *   - Acquired with `writeFileSync({flag: 'wx'})` so creation is
 *     atomic — the OS guarantees only one creator wins the EEXIST
 *     race.
 *   - Released by deleting the file in `finally`.
 *   - A lock is only treated as abandoned (and reaped) when its mtime
 *     is older than STALE_LOCK_MS AND the PID inside is no longer a
 *     live process. The two-condition check prevents a slow-but-alive
 *     holder (NFS hang, swap thrash, debugger SIGSTOP) from being
 *     reaped concurrently with its own write — a same-machine concern
 *     since the lock only protects same-machine contention anyway.
 *   - We poll on EEXIST with short backoff up to `LOCK_TIMEOUT_MS`. In
 *     the common case (no contention) the loop runs once.
 */
const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000
const LOCK_POLL_MS = 50

/** Backing buffer for `Atomics.wait` — the standard Node.js mechanism for
 *  a sync sleep without burning CPU. Allocated once at module scope so the
 *  acquireLock retry loop doesn't churn a fresh SharedArrayBuffer per
 *  iteration. The integer value is never read or written; only the
 *  blocking semantics of `Atomics.wait(buf, 0, 0, ms)` — which sleeps for
 *  up to `ms` ms and returns 'timed-out' since no one ever calls
 *  Atomics.notify — are used. */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4))

function syncSleep(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms)
}

function lockFilePath(targetPath: string): string {
  return `${targetPath}.lock`
}

/** True if `pid` is unset, unparseable, or no longer a live process on
 *  this machine. `process.kill(pid, 0)` is the standard liveness probe:
 *  signal 0 performs the existence/permission check without delivering
 *  anything. ESRCH (no such process) means dead; EPERM means alive but
 *  owned by another user (still alive — don't reap). Any other thrown
 *  error is treated conservatively as "still alive" so we never reap a
 *  lock we can't prove is dead. */
function isPidDead(raw: string): boolean {
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function acquireLock(targetPath: string): void {
  const lock = lockFilePath(targetPath)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (true) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Reap a stale lock only if the holder is provably gone — both
      // mtime past the staleness threshold AND PID no longer alive.
      // Reaping a slow-but-alive holder would let two processes into
      // the critical section together.
      try {
        const age = Date.now() - statSync(lock).mtimeMs
        if (age > STALE_LOCK_MS) {
          let holderPid = ''
          try {
            holderPid = readFileSync(lock, 'utf-8')
          } catch {
            /* lock vanished; retry */
          }
          if (isPidDead(holderPid)) {
            try {
              unlinkSync(lock)
            } catch {
              /* another waiter unlinked it first; fall through to retry */
            }
            continue
          }
        }
      } catch {
        // Lock vanished between EEXIST and stat: retry immediately.
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `cccollab: timed out after ${LOCK_TIMEOUT_MS}ms waiting for ${lock}. ` +
            `If you are sure no other cccollab process is running, delete the lock file and try again.`,
          { cause: err },
        )
      }
      // Sleep briefly before retrying. The config save path is
      // synchronous, so we can't await `setTimeout`; `Atomics.wait` is the
      // standard Node sync-sleep primitive that does not burn CPU. Under
      // contention by multiple MCP processes this keeps the waiter at
      // ~0% CPU instead of pegging a core.
      syncSleep(LOCK_POLL_MS)
    }
  }
}

function releaseLock(targetPath: string): void {
  try {
    unlinkSync(lockFilePath(targetPath))
  } catch {
    // Best-effort: a stale-lock reaper from a peer may have already
    // unlinked the file. Either way, the lock is no longer held.
  }
}

/** Run a synchronous critical section holding `targetPath`'s lock. */
export function withFileLockSync<T>(targetPath: string, callback: () => T): T {
  acquireLock(targetPath)
  try {
    return callback()
  } finally {
    releaseLock(targetPath)
  }
}

/** Async form of `withFileLockSync`. The lock is released in `finally`,
 *  so a thrown rejection releases cleanly. */
export async function withFileLock<T>(targetPath: string, callback: () => Promise<T>): Promise<T> {
  acquireLock(targetPath)
  try {
    return await callback()
  } finally {
    releaseLock(targetPath)
  }
}

/**
 * Write `contents` to `targetPath` atomically at the given mode.
 *
 * Writes to a sibling `<file>.<pid>.tmp` and renames, so a crash
 * mid-write can't leave a truncated file on disk — a reader either sees
 * the whole previous file or the whole new one. Windows' NTFS rename is
 * less strict but avoids the chmod path; callers there get best-effort.
 *
 * Does NOT take the lock: callers that need read-modify-write coherence
 * must already hold it via `withFileLockSync` / `withFileLock`.
 */
export function writeFileAtomic(targetPath: string, contents: string, mode: number): void {
  const tmp = `${targetPath}.${process.pid}.tmp`
  writeFileSync(tmp, contents, { mode })
  try {
    chmodSync(tmp, mode)
  } catch {
    // chmod failed (probably Windows); tolerated - the mode arg above
    // already covers POSIX.
  }
  renameSync(tmp, targetPath)
}
