/**
 * Pure paging logic for topic read-history, extracted from the broker so it
 * can be unit-tested without spawning the HTTP server (importing `broker.ts`
 * starts a listener as a side effect). The broker maps its in-memory messages
 * to epoch-ms `HistoryEntry`s and delegates the windowing here.
 */

export const HISTORY_DEFAULT_LIMIT = 50
export const HISTORY_MAX_LIMIT = 200

/** Clamp a raw `?limit=` value to [1, 200], defaulting to 50 when absent/invalid. */
export function clampHistoryLimit(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(n)) return HISTORY_DEFAULT_LIMIT
  return Math.max(1, Math.min(HISTORY_MAX_LIMIT, Math.floor(n)))
}

/** One message, timestamp already normalized to epoch-ms. */
export interface HistoryEntry {
  sender: string
  text: string
  ts: number
}

/** A page of history, oldest-first. `hasMore` means older messages remain. */
export interface HistoryPage {
  messages: HistoryEntry[]
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
export function pageTopicHistory(
  all: readonly HistoryEntry[],
  opts: { limit: number; before: number | null },
): HistoryPage {
  const older = opts.before === null ? all : all.filter((m) => m.ts < opts.before!)
  let start = Math.max(0, older.length - opts.limit)
  while (start > 0 && older[start - 1]!.ts === older[start]!.ts) start--
  return { messages: older.slice(start), hasMore: start > 0 }
}
