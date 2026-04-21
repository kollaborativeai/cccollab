import { describe, it, expect, vi } from 'vitest'
import { buildLocalEventPayload, forwardRowToBroker, type ConvexMessageRow } from '../src/bridge/convex-bridge.js'

describe('convex bridge', () => {
  it('builds a /local-event payload from a message row + topic context', () => {
    const row: ConvexMessageRow = {
      _id: 'msg_1',
      _creationTime: 1700000000000,
      topicId: 'topic_1',
      authorType: 'external',
      authorKey: 'clerk_abc',
      authorName: 'Alice',
      text: 'hello world',
    }
    const payload = buildLocalEventPayload(row, { topicName: 'design', channel: 'eng' })
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
      _id: 'msg_2',
      _creationTime: 1700000000000,
      topicId: 'topic_1',
      authorType: 'session',
      authorKey: 'dev',
      authorName: 'reviewer',
      text: 'ack',
    }
    expect(buildLocalEventPayload(row, { topicName: 'x', channel: 'c' }).authorType).toBe('session')
  })

  it('forwardRowToBroker POSTs the payload to the broker URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const row: ConvexMessageRow = {
      _id: 'msg_3',
      _creationTime: 1700000000000,
      topicId: 'topic_7',
      authorType: 'external',
      authorKey: 'ck',
      authorName: 'Bob',
      text: 'yo',
    }
    await forwardRowToBroker(
      row,
      { topicName: 't', channel: 'eng' },
      {
        brokerUrl: 'http://127.0.0.1:9999',
        fetch: fakeFetch,
      },
    )
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/local-event')
    expect(calls[0]!.init?.method).toBe('POST')
    const body = JSON.parse((calls[0]!.init?.body as string) ?? '{}') as { sender: string; text: string }
    expect(body.sender).toBe('Bob')
    expect(body.text).toBe('yo')
  })
})
