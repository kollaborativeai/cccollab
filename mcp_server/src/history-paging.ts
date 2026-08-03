/**
 * Pure paging logic for read-history (topic broadcasts and 1:1 threads
 * alike), extracted from the broker so it can be unit-tested without
 * spawning the HTTP server (importing `broker.ts` starts a listener as a
 * side effect). The broker normalizes its in-memory messages to epoch-ms
 * `ts` and delegates the windowing here.
 */

export const HISTORY_DEFAULT_LIMIT = 50
export const HISTORY_MAX_LIMIT = 200

/** Clamp a raw `?limit=` value to [1, 200], defaulting to 50 when absent/invalid. */
export function clampHistoryLimit(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(n)) return HISTORY_DEFAULT_LIMIT
  return Math.max(1, Math.min(HISTORY_MAX_LIMIT, Math.floor(n)))
}

/** Anything pageable: one message whose timestamp is epoch-ms. Topic history
 *  carries `{sender, text}`, a 1:1 thread carries `{fromId, fromName, text}` -
 *  the windowing only ever looks at `ts`. */
export interface HistoryEntry {
  ts: number
}

/** A page of history, oldest-first. `hasMore` means older messages remain. */
export interface HistoryPage<T extends HistoryEntry> {
  messages: T[]
  hasMore: boolean
}

/**
 * Page `all` (oldest-first) newest-page-first: return the newest `limit`
 * messages older than `before`, oldest-first within the page.
 *
 * The page cursor is timestamp-based (`before` filters `ts < before`), but
 * timestamps are ms-precision and therefore NOT unique. If a count-based
 * boundary were allowed to split a group of equal-`ts` messages, the next
 * request (`before = oldestTs`) would exclude the siblings left behind and
 * silently drop them. So we grow the page downward to swallow any equal-`ts`
 * group that straddles the boundary — the strict-`<` cursor then stays exact
 * (no drop, no duplicate) while the `oldestTs`-only contract is preserved.
 */
export function pageHistory<T extends HistoryEntry>(
  all: readonly T[],
  opts: { limit: number; before: number | null },
): HistoryPage<T> {
  const older = opts.before === null ? all : all.filter((m) => m.ts < opts.before!)
  let start = Math.max(0, older.length - opts.limit)
  while (start > 0 && older[start - 1]!.ts === older[start]!.ts) start--
  return { messages: older.slice(start), hasMore: start > 0 }
}
