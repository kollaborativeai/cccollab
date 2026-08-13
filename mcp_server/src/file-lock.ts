import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'

import { CLERK_FETCH_TIMEOUT_MS } from './remote/auth-clerk.js'

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
 *
 * LOCK_TIMEOUT_MS must EXCEED the longest work held under the lock
 * (Clerk token refresh, {@link CLERK_FETCH_TIMEOUT_MS}). A 5 s lock with a
 * 10 s fetch made every healthy-but-slow refresh time out every peer and
 * told them to delete a live lock — exactly the concurrent double-refresh
 * this module exists to prevent (cc#33 / KAI-417). Derived in code so the
 * two constants cannot drift apart again.
 */
/** Headroom after the in-lock Clerk fetch so a peer waits out a full refresh. */
const LOCK_HEADROOM_MS = 5_000
export const LOCK_TIMEOUT_MS = CLERK_FETCH_TIMEOUT_MS + LOCK_HEADROOM_MS
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

/** One contention retry: honour the acquire deadline and sleep before the
 *  next `wx` attempt. Bare `continue` in the acquire loop used to skip both
 *  the deadline check and `syncSleep`, so a persistent lock-read failure
 *  (EISDIR, EACCES on a stale path) spun the event loop at 100 % forever
 *  (cc#33 C1 / KAI-417). Keep the fail-closed reaper logic; never skip loop
 *  liveness. */
function waitForLockRetry(lock: string, deadline: number, cause?: unknown): void {
  if (Date.now() >= deadline) {
    throw new Error(
      `cccollab: timed out after ${LOCK_TIMEOUT_MS}ms waiting for ${lock}. ` +
        `Another cccollab process may still be refreshing tokens — wait and retry. ` +
        `Only delete the lock file if you are certain no cccollab process is running ` +
        `(deleting a live lock can burn the single-use Clerk refresh token).`,
      { cause },
    )
  }
  syncSleep(LOCK_POLL_MS)
}

/** True only when `pid` is PROVABLY a dead process on this machine.
 *  `process.kill(pid, 0)` is the standard liveness probe: signal 0
 *  performs the existence/permission check without delivering anything.
 *  ESRCH (no such process) means dead; EPERM means alive but owned by
 *  another user (still alive — don't reap). Any other thrown error is
 *  treated conservatively as "still alive" so we never reap a lock we
 *  can't prove is dead.
 *
 *  FAIL-CLOSED on an empty / unparseable body (cc#33 / KAI-417): this used
 *  to return `true`, i.e. it treated "I could not read a PID" as proof of
 *  death. Combined with the caller's unlink-by-path, that let a waiter
 *  delete a LIVE holder's lock — e.g. a torn read landing in the gap
 *  between a peer's reap-unlink and its `wx` re-create — putting two
 *  processes in the critical section, both burning the same single-use
 *  Clerk refresh token. Absence of evidence is not evidence of death.
 *
 *  Tradeoff (accepted): a process crashing between the lock file's
 *  `open()` and its `write()` leaves a 0-byte lock that is now never
 *  auto-reaped and needs one manual `rm`. That is a LOUD, recoverable
 *  failure — the acquire timeout already tells the user to delete the
 *  lock file — and is strictly preferable to a silent double-refresh
 *  that forces a re-authentication. */
function isPidDead(raw: string): boolean {
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid) || pid <= 0) return false
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
          let holderPid: string
          try {
            holderPid = readFileSync(lock, 'utf-8')
          } catch {
            // The lock vanished between `stat` and this read — a peer
            // reaped it. Retry the `wx` create rather than falling
            // through: everything below reasons about a holder we just
            // failed to identify, and acting on that was the KAI-417
            // reaper bug (the empty `holderPid` was read as "dead").
            // MUST still sleep + honour the deadline (cc#33): bare
            // `continue` spun forever when the path is permanently unreadable.
            waitForLockRetry(lock, deadline, err)
            continue
          }
          if (isPidDead(holderPid)) {
            try {
              unlinkSync(lock)
            } catch {
              /* another waiter unlinked it first; fall through to retry */
            }
            waitForLockRetry(lock, deadline, err)
            continue
          }
        }
      } catch {
        // Lock vanished between EEXIST and stat: retry with sleep + deadline.
        waitForLockRetry(lock, deadline, err)
        continue
      }
      // Live holder still holding (or age under STALE_LOCK_MS): wait and retry.
      waitForLockRetry(lock, deadline, err)
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

/**
 * In-process async gate in front of the on-disk lock.
 *
 * `acquireLock` is a synchronous spin (Atomics.wait) that blocks the whole
 * event loop, and `withFileLock` holds the file lock across an `await`
 * (the network token refresh). With two remote locations, refresh A takes
 * the lock and yields on its await; refresh B — in the SAME process — then
 * calls `acquireLock`, sees a lock file owned by its own live PID (so never
 * reapable), and spins the event loop so A can never resume to release it.
 * Guaranteed self-deadlock at LOCK_TIMEOUT_MS (cc#33 / KAI-417).
 *
 * Fix: same-process users queue on a promise chain and never spin on a lock
 * their own process holds. The on-disk lock file keeps doing only its real
 * job — cross-process mutual exclusion — and is now only ever contended by
 * genuinely foreign processes.
 *
 * Every entry point must go through this gate. There is deliberately NO
 * synchronous public form: a sync writer cannot join a promise chain, so it
 * would spin against an in-flight async holder and reintroduce exactly the
 * deadlock above. `withFileLockSync` was removed (KAI-415 + cc#33
 * reconciliation) and `saveLocationAuth` made async for that reason.
 */
const lockChains = new Map<string, Promise<unknown>>()

function withInProcessFileLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const prior = lockChains.get(targetPath) ?? Promise.resolve()
  const next = prior.then(run, run)
  // Swallow rejections on the chain itself so one failing critical section
  // doesn't reject every subsequent waiter.
  lockChains.set(
    targetPath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/** Run an async critical section holding `targetPath`'s lock, serialised
 *  in-process first and cross-process second. The lock is released in
 *  `finally`, so a thrown rejection releases cleanly. */
export async function withFileLock<T>(targetPath: string, callback: () => Promise<T>): Promise<T> {
  return await withInProcessFileLock(targetPath, async () => {
    acquireLock(targetPath)
    try {
      return await callback()
    } finally {
      releaseLock(targetPath)
    }
  })
}

/**
 * Write `contents` to `targetPath` atomically at the given mode.
 *
 * Writes to a sibling `<file>.<pid>.tmp` and renames, so a crash
 * mid-write can't leave a truncated file on disk — a reader either sees
 * the whole previous file or the whole new one. Windows' NTFS rename is
 * less strict but avoids the chmod path; callers there get best-effort.
 *
 * KAI-415 I7: open the tmp with O_CREAT|O_EXCL|O_NOFOLLOW so a same-UID
 * attacker cannot plant a symlink at the predictable pid-tmp path and
 * redirect the write (session JSON or config tokens via the same helper).
 * If a stale tmp from a previous crash is present, unlink and retry once.
 *
 * Does NOT take the lock: callers that need read-modify-write coherence
 * must already hold it via `withFileLockSync` / `withFileLock`.
 */
export function writeFileAtomic(targetPath: string, contents: string, mode: number): void {
  const tmp = `${targetPath}.${process.pid}.tmp`
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  let fd: number | undefined
  try {
    fd = openSync(tmp, flags, mode)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      // Stale tmp from a prior crash — remove and retry once.
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      fd = openSync(tmp, flags, mode)
    } else {
      // Platforms without O_NOFOLLOW / O_EXCL fall back to plain write.
      writeFileSync(tmp, contents, { mode })
      try {
        chmodSync(tmp, mode)
      } catch {
        /* Windows */
      }
      renameSync(tmp, targetPath)
      return
    }
  }
  try {
    writeSync(fd, contents)
    try {
      fchmodSync(fd, mode)
    } catch {
      /* Windows */
    }
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, targetPath)
}
