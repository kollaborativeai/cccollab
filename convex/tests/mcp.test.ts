import { describe, it, expect } from 'vitest'
import { convexTest } from 'convex-test'

import { api } from '../_generated/api'
import schema from '../schema'
import { sha256Base64Url } from '../lib/crypto'
import { identityFor, seedUser } from './helpers'

const modules = import.meta.glob('../**/*.ts')

type TokenResponse = {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
  scope: string
}

/**
 * Helper: drive the full OAuth flow for a seeded user and return the bearer
 * access token. Shared across MCP tests so each individual test focuses on
 * what happens *after* auth rather than re-running register+authorize+token.
 */
async function bearerFor(
  t: ReturnType<typeof convexTest>,
  userId: Awaited<ReturnType<typeof seedUser>>,
  clientName = 'Test AI',
): Promise<{ accessToken: string; clientId: string }> {
  const client = await t.mutation(api.oauth.register.register, {
    clientName,
    redirectUris: ['http://127.0.0.1:8765/cb'],
    tokenEndpointAuthMethod: 'none',
  })
  const verifier = 'verifier-0123456789abcdef0123456789abcdef'
  const challenge = await sha256Base64Url(verifier)
  const { code } = await t.withIdentity(identityFor(userId)).mutation(api.oauth.authorize.issueAuthCode, {
    clientId: client.client_id,
    redirectUri: 'http://127.0.0.1:8765/cb',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    scope: 'cccollab:topics.rw',
  })
  const tokens = (await t.action(api.oauth.token.exchangeAuthCode, {
    clientId: client.client_id,
    clientName,
    code,
    codeVerifier: verifier,
    redirectUri: 'http://127.0.0.1:8765/cb',
  })) as TokenResponse
  return { accessToken: tokens.access_token, clientId: client.client_id }
}

async function postJsonRpc(
  t: ReturnType<typeof convexTest>,
  accessToken: string,
  rpc: Record<string, unknown>,
): Promise<Response> {
  return await t.fetch('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(rpc),
  })
}

describe('/mcp — auth', () => {
  it('rejects missing Authorization header with 401 + WWW-Authenticate', async () => {
    const t = convexTest(schema, modules)
    const res = await t.fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/)
  })

  it('rejects invalid bearer with 401 + invalid_token', async () => {
    const t = convexTest(schema, modules)
    const res = await t.fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/invalid_token/)
  })
})

describe('/mcp — dispatcher', () => {
  it('initialize returns server info + capabilities + protocol version', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions', 'Alice')
    const { accessToken } = await bearerFor(t, userId)
    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      jsonrpc: string
      id: number
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: unknown }
    }
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'cccollab' },
        capabilities: { tools: { listChanged: false } },
      },
    })
  })

  it('tools/list returns the three MCP tools', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions', 'Alice')
    const { accessToken } = await bearerFor(t, userId)
    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } }
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(['list_topics', 'read_topic', 'send_message_to_topic'])
  })

  it('notifications/* produces a 202 with no body', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions', 'Alice')
    const { accessToken } = await bearerFor(t, userId)
    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(res.status).toBe(202)
  })

  it('unknown method returns JSON-RPC -32601', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions', 'Alice')
    const { accessToken } = await bearerFor(t, userId)
    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 42,
      method: 'nonexistent',
    })
    const body = (await res.json()) as { error?: { code: number } }
    expect(body.error?.code).toBe(-32601)
  })

  it('tools/call with non-object params returns -32602 Invalid params', async () => {
    const t = convexTest(schema, modules)
    const userId = await seedUser(t, 'alice@flatout.solutions', 'Alice')
    const { accessToken } = await bearerFor(t, userId)
    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: 'oops',
    })
    const body = (await res.json()) as { error?: { code: number } }
    expect(body.error?.code).toBe(-32602)
  })
})

describe('/mcp — tools end-to-end', () => {
  async function seedWithTopic(t: ReturnType<typeof convexTest>, email: string) {
    const userId = await seedUser(t, email, email.split('@')[0])
    const asUser = t.withIdentity(identityFor(userId))
    const sessionId = await asUser.mutation(api.sessions.mutations.introduce, { sessionName: 'laptop' })
    await asUser.mutation(api.channels.mutations.join, { sessionId, channel: 'eng' })
    const { topicId } = await asUser.mutation(api.topics.mutations.start, {
      sessionId,
      channel: 'eng',
      topic: 'design-review',
    })
    return { userId, sessionId, topicId }
  }

  it('list_topics returns topics in channels the user is a member of', async () => {
    const t = convexTest(schema, modules)
    const { userId, topicId } = await seedWithTopic(t, 'alice@flatout.solutions')
    const { accessToken } = await bearerFor(t, userId)

    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_topics', arguments: {} },
    })
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }
    expect(body.result.isError).toBeFalsy()
    const content = JSON.parse(body.result.content[0]!.text) as {
      topics: Array<{ id: string; name: string }>
    }
    expect(content.topics.length).toBe(1)
    expect(content.topics[0]!.id).toBe(topicId)
    expect(content.topics[0]!.name).toBe('design-review')
  })

  it('list_topics returns empty for users with no channel membership', async () => {
    const t = convexTest(schema, modules)
    await seedWithTopic(t, 'alice@flatout.solutions')
    const bobId = await seedUser(t, 'bob@flatout.solutions', 'bob')
    const { accessToken } = await bearerFor(t, bobId)

    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_topics', arguments: {} },
    })
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
    const content = JSON.parse(body.result.content[0]!.text) as { topics: unknown[] }
    expect(content.topics).toEqual([])
  })

  it('send_message_to_topic posts, attributed via the synthetic external session', async () => {
    const t = convexTest(schema, modules)
    const { userId, topicId } = await seedWithTopic(t, 'alice@flatout.solutions')
    const { accessToken } = await bearerFor(t, userId, 'Claude.ai')

    const sendRes = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'send_message_to_topic',
        arguments: { topicId, text: 'hello from Claude.ai' },
      },
    })
    const sendBody = (await sendRes.json()) as { result: { isError: boolean } }
    expect(sendBody.result.isError).toBeFalsy()

    // Verify it was written with the synthetic session, not Alice's real one.
    const messages = await t.run(async (ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_topic_and_ts', (q) => q.eq('topicId', topicId))
        .collect(),
    )
    expect(messages.length).toBe(1)
    expect(messages[0]!.text).toBe('hello from Claude.ai')
    expect(messages[0]!.kind).toBe('topic')
    expect(messages[0]!.fromUserId).toBe(userId)
    // Synthetic session name contains "external"
    const senderSession = await t.run(async (ctx) => ctx.db.get(messages[0]!.fromSessionId))
    expect(senderSession?.sessionName).toContain('external')
    expect(senderSession?.sessionName).toContain('Claude.ai')
  })

  it('read_topic returns messages including ones posted by the same external AI', async () => {
    const t = convexTest(schema, modules)
    const { userId, topicId } = await seedWithTopic(t, 'alice@flatout.solutions')
    const { accessToken } = await bearerFor(t, userId, 'Claude.ai')

    await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_message_to_topic', arguments: { topicId, text: 'hi' } },
    })

    const readRes = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'read_topic', arguments: { topicId } },
    })
    const body = (await readRes.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }
    expect(body.result.isError).toBeFalsy()
    const content = JSON.parse(body.result.content[0]!.text) as {
      topic: { name: string }
      messages: Array<{ text: string }>
    }
    expect(content.topic.name).toBe('design-review')
    expect(content.messages.map((m) => m.text)).toEqual(['hi'])
  })

  it('send_message_to_topic rejects writes to a topic whose channel the user is not subscribed to', async () => {
    const t = convexTest(schema, modules)
    // Alice creates the topic.
    const { topicId } = await seedWithTopic(t, 'alice@flatout.solutions')
    // Bob tries to post through MCP without ever joining #eng.
    const bobId = await seedUser(t, 'bob@flatout.solutions', 'bob')
    const { accessToken } = await bearerFor(t, bobId)

    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'send_message_to_topic',
        arguments: { topicId, text: 'trespass' },
      },
    })
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(true)
    const content = JSON.parse(body.result.content[0]!.text) as { error: string }
    expect(content.error).toMatch(/NOT_CHANNEL_MEMBER|not a member/i)

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query('messages')
        .withIndex('by_topic_and_ts', (q) => q.eq('topicId', topicId))
        .collect(),
    )
    expect(messages.length).toBe(0)
  })

  it('read_topic returns a structured error for topics the user cannot see', async () => {
    const t = convexTest(schema, modules)
    const { topicId } = await seedWithTopic(t, 'alice@flatout.solutions')
    const bobId = await seedUser(t, 'bob@flatout.solutions', 'bob')
    const { accessToken } = await bearerFor(t, bobId)

    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_topic', arguments: { topicId } },
    })
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean } }
    const content = JSON.parse(body.result.content[0]!.text) as { error: string }
    expect(content.error).toBe('topic_not_found_or_not_a_member')
  })

  it('read_topic hides archived topics even from members', async () => {
    const t = convexTest(schema, modules)
    const { userId, sessionId, topicId } = await seedWithTopic(t, 'alice@flatout.solutions')
    const asUser = t.withIdentity(identityFor(userId))
    await asUser.mutation(api.topics.mutations.archive, { sessionId, topicId })
    const { accessToken } = await bearerFor(t, userId)

    const res = await postJsonRpc(t, accessToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_topic', arguments: { topicId } },
    })
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } }
    const content = JSON.parse(body.result.content[0]!.text) as { error?: string }
    expect(content.error).toBe('topic_not_found_or_not_a_member')
  })
})

describe('/mcp — well-known metadata', () => {
  it('authorization-server metadata is reachable and matches the deployment base URL', async () => {
    const t = convexTest(schema, modules)
    const res = await t.fetch('/.well-known/oauth-authorization-server', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { issuer: string; authorization_endpoint: string; token_endpoint: string }
    expect(body.authorization_endpoint.endsWith('/authorize')).toBe(true)
    expect(body.token_endpoint.endsWith('/token')).toBe(true)
  })

  it('protected-resource metadata references /mcp', async () => {
    const t = convexTest(schema, modules)
    const res = await t.fetch('/.well-known/oauth-protected-resource', { method: 'GET' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resource: string }
    expect(body.resource.endsWith('/mcp')).toBe(true)
  })
})
