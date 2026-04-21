import { describe, it, expect, vi } from 'vitest'
import { buildLocalEventPayload, forwardRowToBroker, type ConvexMessageRow } from '../src/bridge/convex-bridge.js'

const baseRow: ConvexMessageRow = {
  _id: 'msg_1',
  _creationTime: 1700000000000,
  topicId: 'topic_1',
  authorType: 'external',
  authorKey: 'clerk_abc',
  authorName: 'Alice',
  text: 'hello world',
  topicName: 'design',
  channelName: 'eng',
}

describe('convex bridge', () => {
  it('builds a /local-event payload from a hydrated message row', () => {
    const payload = buildLocalEventPayload(baseRow)
    expect(payload).toEqual({
      type: 'message',
      channel: 'eng',
      topicId: 'topic_1',
      topicName: 'design',
      sender: 'Alice',
      authorType: 'external',
      text: 'hello world',
      ts: new Date(1700000000000).toISOString(),
    })
  })

  it('preserves session authorType when forwarding', () => {
    const row: ConvexMessageRow = {
      ...baseRow,
      _id: 'msg_2',
      authorType: 'session',
      authorKey: 'dev',
      authorName: 'reviewer',
      text: 'ack',
    }
    expect(buildLocalEventPayload(row).authorType).toBe('session')
  })

  it('forwardRowToBroker POSTs the payload to the broker URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const row: ConvexMessageRow = {
      ...baseRow,
      _id: 'msg_3',
      authorName: 'Bob',
      text: 'yo',
    }
    await forwardRowToBroker(row, { brokerUrl: 'http://127.0.0.1:9999', fetch: fakeFetch })
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/local-event')
    expect(calls[0]!.init?.method).toBe('POST')
    const body = JSON.parse((calls[0]!.init?.body as string) ?? '{}') as { sender: string; text: string }
    expect(body.sender).toBe('Bob')
    expect(body.text).toBe('yo')
  })

  it('forwardRowToBroker swallows fetch errors (best-effort)', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('broker unreachable')
    }) as unknown as typeof fetch
    await expect(
      forwardRowToBroker(baseRow, { brokerUrl: 'http://127.0.0.1:9999', fetch: fakeFetch }),
    ).resolves.toBeUndefined()
  })
})
