import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConvexClient } from 'convex/browser'

import { MessageBus } from '../src/message-bus.js'
import { RemoteTransport } from '../src/transport/remote.js'
import type { InboundImage } from '../src/types.js'

/**
 * TWO SCREENSHOTS IN THE SAME SECOND MUST BOTH ARRIVE.
 *
 * `dedupKey` was `sender|stream|second|text`, with nothing about the attachments.
 * Pasting two images in one second — same person, same topic, and the empty
 * caption the web UI sends by default — produced one key for two different
 * pictures. While a dedup hit only skipped a notification that was survivable.
 * C2 made the resolution of `push` the thing that advances `seen` /
 * `topicMaxTs` / `ackChannel`, so the hit became an ACK for a message nobody
 * saw, and the cursor is what a reconnect resumes from.
 *
 * This drives the REAL `RemoteTransport` and the REAL `MessageBus`, wired the way
 * `attach.ts` wires them in production (the callback RETURNS `bus.push`), across
 * two `onUpdate` batches — Convex re-delivers the full result set per update, so
 * the first row is `seen` and only the second is new. That sequencing matters:
 * the dedup key is claimed only after a successful notify, so this fails only
 * when the first delivery has genuinely completed before the second row arrives,
 * which is the ordinary interleaving rather than a contrived one.
 *
 * Deleting `imageIdentity` from `dedupKey` turns both assertions RED: one
 * notification instead of two, and a resubscribe cursor sitting on the row that
 * was never delivered.
 *
 * (A superficially similar dedup claim on this branch was WITHDRAWN: it needed
 * the local broker and the remote subscription to collapse into one key, and they
 * cannot, because the broker puts a human name in `sender` while the remote puts
 * a raw session id. That rebuttal does not reach this case — both rows here come
 * through ONE transport, so both carry the same `row.fromSessionId`.)
 */

let dir: string

// Downloads go to the user's real ~/.cccollab/images unless redirected, and the
// bus calls `renderInboundText` with no `dir` of its own.
vi.mock('../src/attachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/attachments.js')>()
  return {
    ...actual,
    renderInboundText: (
      raw: { text: string; images?: InboundImage[]; ts?: number },
      opts: { dir?: string; now?: number } = {},
    ) => actual.renderInboundText(raw, { ...opts, dir: process.env.CCCOLLAB_TEST_IMAGE_DIR }),
  }
})

/** Real PNG signature — the download refuses a body that is not the type it claims. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
    })),
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cccollab-dedup-'))
  process.env.CCCOLLAB_TEST_IMAGE_DIR = dir
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.CCCOLLAB_TEST_IMAGE_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** Delivery and the watermark advance in a fire-and-forget chain after notify. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

function img(name: string): InboundImage {
  return { name, url: `https://files.example/api/storage/${name}`, mimeType: 'image/png', size: 8 }
}

describe('dedup: two same-second images from one sender', () => {
  it('delivers the second screenshot instead of acking it unseen', async () => {
    stubFetch()
    let deliver: ((rows: unknown) => void) | undefined
    const subscribeArgs: Array<Record<string, unknown>> = []
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => undefined),
      onUpdate: vi.fn((_q: unknown, args: Record<string, unknown>, cb: (rows: unknown) => void) => {
        subscribeArgs.push(args)
        deliver = cb
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    const mcp = { notification: vi.fn().mockResolvedValue(undefined) }
    const bus = new MessageBus(mcp as never)

    const subscribe = (): void => {
      transport.subscribeTopicMessages({ topicId: 't1', channelName: 'general' }, (msg) =>
        // Production wiring (attach.ts): RETURNED, not voided.
        bus.push(msg, transport.source),
      )
    }
    subscribe()

    // Same UTC second, same (empty) caption, same sender — different pictures.
    const T = 1_700_000_000_000
    const rowA = { _id: 'm1', fromSessionId: 'web-user', text: '', ts: T, images: [img('a.png')] }
    const rowB = { _id: 'm2', fromSessionId: 'web-user', text: '', ts: T + 400, images: [img('b.png')] }

    deliver!([rowA])
    await settle()
    expect(mcp.notification).toHaveBeenCalledTimes(1)

    // Convex re-delivers the whole result set; rowA is already `seen`.
    deliver!([rowA, rowB])
    await settle()

    const contents = mcp.notification.mock.calls.map(
      (call) => (call[0] as { params: { content: string } }).params.content,
    )
    expect(mcp.notification).toHaveBeenCalledTimes(2)
    // Not just "two notifications" — the SECOND picture is the one at risk.
    expect(contents.some((text) => text.includes('a.png'))).toBe(true)
    expect(contents.some((text) => text.includes('b.png'))).toBe(true)

    // And the cursor must only ever sit on a row that was actually shown. When
    // the drop happened, this still advanced to rowB.ts — so the resubscribe
    // asked for messages strictly after the screenshot nobody saw.
    subscribe()
    expect(subscribeArgs.at(-1)).toEqual({ topicId: 't1', sinceTs: rowB.ts })
  })

  it('still collapses the same image arriving twice', async () => {
    stubFetch()
    let deliver: ((rows: unknown) => void) | undefined
    const stub = {
      query: vi.fn(async () => undefined),
      mutation: vi.fn(async () => undefined),
      onUpdate: vi.fn((_q: unknown, _a: Record<string, unknown>, cb: (rows: unknown) => void) => {
        deliver = cb
        return () => {}
      }),
      setAuth: vi.fn(),
    }
    const transport = new RemoteTransport({ client: stub as unknown as ConvexClient, log: () => {} })
    const mcp = { notification: vi.fn().mockResolvedValue(undefined) }
    const bus = new MessageBus(mcp as never)
    transport.subscribeTopicMessages({ topicId: 't1', channelName: 'general' }, (msg) =>
      bus.push(msg, transport.source),
    )

    // The case the dedup window exists for: one logical send seen twice. Distinct
    // row ids so the transport's own `_id` guard cannot be what saves it.
    const T = 1_700_000_000_000
    const same = [img('a.png')]
    deliver!([{ _id: 'm1', fromSessionId: 'web-user', text: 'look', ts: T, images: same }])
    await settle()
    deliver!([
      { _id: 'm1', fromSessionId: 'web-user', text: 'look', ts: T, images: same },
      { _id: 'm2', fromSessionId: 'web-user', text: 'look', ts: T + 100, images: same },
    ])
    await settle()

    expect(mcp.notification).toHaveBeenCalledTimes(1)
  })
})
