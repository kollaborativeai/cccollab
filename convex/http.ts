/**
 * Convex HTTP router.
 *
 * Wires Convex Auth's OAuth callback routes (for first-party human sign-in
 * via Google), the OAuth 2.1 authorization-server endpoints for external AI
 * clients (CCC-22), and the MCP streamable-HTTP `/mcp` endpoint those
 * clients use to talk to cccollab topics on behalf of a signed-in user.
 */
import { ConvexError } from 'convex/values'
import { httpRouter } from 'convex/server'

import { api, internal } from './_generated/api'
import { httpAction } from './_generated/server'
import { auth } from './auth'
import { errorResponse, jsonResponse, readFormBody, readJsonBody } from './lib/http'
import { authServerMetadata, protectedResourceMetadata } from './oauth/metadata'
import { dispatchMcp, type JsonRpcRequest } from './mcp/server'

const http = httpRouter()

auth.addHttpRoutes(http)

function baseUrl(req: Request): string {
  return new URL(req.url).origin
}

// --------- OAuth 2.1 metadata (RFC 8414, RFC 9728) ---------

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

// --------- Authorization endpoint (RFC 6749 §4.1 + PKCE) ---------

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

    if (responseType !== 'code') return errorResponse(400, 'unsupported_response_type')
    if (!clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      return errorResponse(
        400,
        'invalid_request',
        'client_id, redirect_uri, code_challenge, code_challenge_method=S256 required',
      )
    }

    let code: string
    try {
      const result = await ctx.runMutation(api.oauth.authorize.issueAuthCode, {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: 'S256',
        scope,
      })
      code = result.code
    } catch (err) {
      if (err instanceof ConvexError) {
        const data = err.data as { code?: string; message?: string } | unknown
        const errCode =
          typeof data === 'object' && data !== null && 'code' in data
            ? String((data as { code: unknown }).code)
            : 'invalid_request'
        if (errCode === 'UNAUTHENTICATED') {
          return new Response(
            '<html><body><h2>Sign in required</h2>' +
              '<p>Authenticate with your cccollab account and retry the authorization request.</p>' +
              '</body></html>',
            { status: 401, headers: { 'Content-Type': 'text/html' } },
          )
        }
        const errMsg =
          typeof data === 'object' &&
          data !== null &&
          'message' in data &&
          typeof (data as { message: unknown }).message === 'string'
            ? (data as { message: string }).message
            : err.message
        return errorResponse(400, errCode.toLowerCase(), errMsg)
      }
      return errorResponse(500, 'server_error', err instanceof Error ? err.message : 'error')
    }

    const redirect = new URL(redirectUri)
    redirect.searchParams.set('code', code)
    if (state) redirect.searchParams.set('state', state)
    return Response.redirect(redirect.toString(), 302)
  }),
})

// --------- Token endpoint (RFC 6749 §3.2) ---------

http.route({
  path: '/token',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
      return errorResponse(
        400,
        'invalid_request',
        'token endpoint requires Content-Type: application/x-www-form-urlencoded',
      )
    }
    const form = await readFormBody(req)
    const grantType = form.get('grant_type')
    const clientId = form.get('client_id') ?? ''
    const clientSecret = form.get('client_secret') ?? undefined

    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? ''
      const codeVerifier = form.get('code_verifier') ?? ''
      const redirectUri = form.get('redirect_uri') ?? ''
      try {
        const tokens = await ctx.runAction(api.oauth.token.exchangeAuthCode, {
          clientId,
          clientSecret,
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
          clientSecret,
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

// --------- MCP streamable HTTP endpoint ---------

http.route({
  path: '/mcp',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    const authHeader = req.headers.get('authorization') ?? ''
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer realm="cccollab mcp", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
        },
      })
    }
    const token = authHeader.slice('Bearer '.length).trim()
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
    const scopes = tokenRow.scope.split(/\s+/).filter(Boolean)
    if (!scopes.includes('cccollab:topics.rw')) {
      return new Response(
        JSON.stringify({ error: 'insufficient_scope', error_description: 'cccollab:topics.rw required' }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="cccollab:topics.rw"',
          },
        },
      )
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
    const response = await dispatchMcp(ctx, { userId: tokenRow.userId, sessionId: tokenRow.sessionId }, body)
    if (response === null) return new Response(null, { status: 202 })
    return jsonResponse(response)
  }),
})

export default http
