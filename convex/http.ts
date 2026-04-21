import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server.js'
import { api, internal } from './_generated/api.js'
import { authServerMetadata, protectedResourceMetadata } from './oauth/metadata.js'
import { errorResponse, jsonResponse, readFormBody, readJsonBody } from './lib/http.js'
import { dispatchMcp, type JsonRpcRequest } from './mcp/server.js'

const http = httpRouter()

function baseUrl(req: Request): string {
  return new URL(req.url).origin
}

// --------- OAuth metadata endpoints ---------

http.route({
  path: '/.well-known/oauth-authorization-server',
  method: 'GET',
  handler: httpAction(async (_ctx, req) => jsonResponse(authServerMetadata(baseUrl(req)))),
})

http.route({
  path: '/.well-known/oauth-protected-resource',
  method: 'GET',
  handler: httpAction(async (_ctx, req) => jsonResponse(protectedResourceMetadata(baseUrl(req)))),
})

// --------- Dynamic Client Registration (RFC 7591) ---------

http.route({
  path: '/register',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    let body: {
      client_name?: string
      redirect_uris?: string[]
      token_endpoint_auth_method?: 'none' | 'client_secret_post'
    }
    try {
      body = await readJsonBody(req)
    } catch {
      return errorResponse(400, 'invalid_request', 'invalid JSON body')
    }
    if (!body.client_name || !Array.isArray(body.redirect_uris)) {
      return errorResponse(400, 'invalid_client_metadata', 'client_name and redirect_uris required')
    }
    try {
      const result = await ctx.runMutation(api.oauth.register.register, {
        clientName: body.client_name,
        redirectUris: body.redirect_uris,
        tokenEndpointAuthMethod: body.token_endpoint_auth_method ?? 'none',
      })
      return jsonResponse(result, { status: 201 })
    } catch (err) {
      return errorResponse(400, 'invalid_client_metadata', err instanceof Error ? err.message : 'error')
    }
  }),
})

// --------- Authorization endpoint (OAuth 2.1 code flow w/ PKCE) ---------

http.route({
  path: '/authorize',
  method: 'GET',
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url)
    const responseType = url.searchParams.get('response_type')
    const clientId = url.searchParams.get('client_id')
    const redirectUri = url.searchParams.get('redirect_uri')
    const codeChallenge = url.searchParams.get('code_challenge')
    const codeChallengeMethod = url.searchParams.get('code_challenge_method')
    const scope = url.searchParams.get('scope') ?? 'cccollab:topics.rw'
    const state = url.searchParams.get('state') ?? ''

    if (responseType !== 'code') {
      return errorResponse(400, 'unsupported_response_type')
    }
    if (!clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      return errorResponse(
        400,
        'invalid_request',
        'client_id, redirect_uri, code_challenge, code_challenge_method=S256 required',
      )
    }

    // Resolve the human user. In production Convex's `ctx.auth.getUserIdentity()`
    // reads the Clerk JWT from the request. For tests we allow X-Test-* headers
    // (never trust these in prod; Convex in prod requires a real Clerk token).
    const identity = await ctx.auth.getUserIdentity()
    let clerkId: string | null = identity?.subject ?? null
    let displayName: string | null = identity?.name ?? identity?.email ?? null
    const email: string | undefined = identity?.email ?? undefined
    if (!clerkId) {
      const testUserId = req.headers.get('x-test-user-id')
      const testUserName = req.headers.get('x-test-user-name')
      if (testUserId) {
        clerkId = testUserId
        displayName = testUserName ?? testUserId
      }
    }
    if (!clerkId || !displayName) {
      return new Response(
        '<html><body><h2>Sign in required</h2><p>Authenticate with your cccollab account (Clerk) and retry the authorization request.</p></body></html>',
        { status: 401, headers: { 'Content-Type': 'text/html' } },
      )
    }

    const userId = await ctx.runMutation(api.users.getOrCreateByClerk, {
      clerkId,
      displayName,
      email,
    })
    const { code } = await ctx.runMutation(api.oauth.authorize.issueAuthCode, {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: 'S256',
      scope,
      userId,
    })

    const redirect = new URL(redirectUri)
    redirect.searchParams.set('code', code)
    if (state) redirect.searchParams.set('state', state)
    return Response.redirect(redirect.toString(), 302)
  }),
})

// --------- Token endpoint (exchange + refresh) ---------

http.route({
  path: '/token',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const form = await readFormBody(req)
    const grantType = form.get('grant_type')
    const clientId = form.get('client_id') ?? ''

    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? ''
      const codeVerifier = form.get('code_verifier') ?? ''
      const redirectUri = form.get('redirect_uri') ?? ''
      try {
        const tokens = await ctx.runAction(api.oauth.token.exchangeAuthCode, {
          clientId,
          code,
          codeVerifier,
          redirectUri,
        })
        return jsonResponse(tokens)
      } catch (err) {
        return errorResponse(400, 'invalid_grant', err instanceof Error ? err.message : 'error')
      }
    }
    if (grantType === 'refresh_token') {
      const refreshToken = form.get('refresh_token') ?? ''
      try {
        const tokens = await ctx.runAction(api.oauth.token.refreshAccessToken, {
          clientId,
          refreshToken,
        })
        return jsonResponse(tokens)
      } catch (err) {
        return errorResponse(400, 'invalid_grant', err instanceof Error ? err.message : 'error')
      }
    }
    return errorResponse(400, 'unsupported_grant_type')
  }),
})

// --------- MCP Streamable HTTP endpoint ---------

http.route({
  path: '/mcp',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const auth = req.headers.get('authorization') ?? ''
    if (!auth.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer realm="cccollab mcp", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
        },
      })
    }
    const token = auth.slice('Bearer '.length).trim()
    const tokenRow = await ctx.runQuery(internal.oauth.tokens.resolveAccessToken, { token })
    if (!tokenRow) {
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer error="invalid_token"',
        },
      })
    }

    let body: JsonRpcRequest
    try {
      body = await readJsonBody<JsonRpcRequest>(req)
    } catch {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const response = await dispatchMcp(ctx, tokenRow.userId, body)
    return jsonResponse(response)
  }),
})

export default http
