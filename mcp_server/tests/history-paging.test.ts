import { describe, it, expect } from 'vitest'
import {
  clampHistoryLimit,
  pageHistory,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  type HistoryEntry,
  type HistoryPage,
} from '../src/history-paging.js'

/** A topic-shaped entry: `pageHistory` only reads `ts`, callers keep their
 *  own fields. */
interface Entry extends HistoryEntry {
  sender: string
  text: string
}

function entry(id: string, ts: number): Entry {
  return { sender: id, text: id, ts }
}

/** Walk the whole history newest-page-first exactly as a client would, and
 *  return the ids in chronological order. Guards against silent drop/dup. */
function fullWalk(store: Entry[], limit: number): string[] {
  const collected: string[] = []
  let before: number | null = null
  for (let guard = 0; guard < 1000; guard++) {
    const older: Entry[] = before === null ? store : store.filter((m) => m.ts < before!)
    const { messages, hasMore }: HistoryPage<Entry> = pageHistory(older, { limit, before })
    collected.unshift(...messages.map((m) => m.text))
    if (!hasMore || messages.length === 0) break
    before = messages[0]!.ts // oldestTs cursor
  }
  return collected
}

describe('clampHistoryLimit', () => {
  it('defaults to 50 when the value is absent or non-numeric', () => {
    expect(clampHistoryLimit(null)).toBe(HISTORY_DEFAULT_LIMIT)
    expect(clampHistoryLimit('abc')).toBe(HISTORY_DEFAULT_LIMIT)
  })

  it('caps at 200 and floors at 1', () => {
    expect(clampHistoryLimit('999999')).toBe(HISTORY_MAX_LIMIT)
    expect(clampHistoryLimit('0')).toBe(1)
    expect(clampHistoryLimit('-5')).toBe(1)
  })

  it('floors fractional values', () => {
    expect(clampHistoryLimit('2.9')).toBe(2)
    expect(clampHistoryLimit('50')).toBe(50)
  })
})

describe('pageHistory', () => {
  it('returns an empty page for empty history', () => {
    expect(pageHistory([], { limit: 50, before: null })).toEqual({ messages: [], hasMore: false })
  })

  it('returns the whole history oldest-first when it fits under the limit', () => {
    const store = [entry('a', 1), entry('b', 2), entry('c', 3)]
    const page = pageHistory(store, { limit: 50, before: null })
    expect(page.messages.map((m) => m.text)).toEqual(['a', 'b', 'c'])
    expect(page.hasMore).toBe(false)
  })

  it('returns the newest page and flags hasMore when history exceeds the limit', () => {
    const store = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4)]
    const page = pageHistory(store, { limit: 2, before: null })
    expect(page.messages.map((m) => m.text)).toEqual(['c', 'd'])
    expect(page.hasMore).toBe(true)
  })

  it('excludes messages at or after the `before` cursor (strict <)', () => {
    const store = [entry('a', 1), entry('b', 2), entry('c', 3)]
    const page = pageHistory(store, { limit: 50, before: 3 })
    expect(page.messages.map((m) => m.text)).toEqual(['a', 'b'])
  })

  it('never drops or duplicates a message across a full paged walk (distinct timestamps)', () => {
    const store = [entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4), entry('e', 5)]
    expect(fullWalk(store, 2)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('does not split an equal-timestamp group across a page boundary (KAI-371 regression)', () => {
    // Two messages share ms 1000; a naive count-slice + strict-`<` cursor drops
    // the sibling left on the older side of the boundary.
    const store = [entry('a1', 1000), entry('b1', 1000), entry('a2', 1005)]
    expect(fullWalk(store, 2)).toEqual(['a1', 'b1', 'a2'])
  })

  it('keeps a 3-wide equal-timestamp group intact across pages', () => {
    const store = [entry('x0', 500), entry('e1', 1000), entry('e2', 1000), entry('e3', 1000), entry('z9', 2000)]
    expect(fullWalk(store, 2)).toEqual(['x0', 'e1', 'e2', 'e3', 'z9'])
  })
})
