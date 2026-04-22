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

/**
 * Produce an RFC-6749-friendly `error_description` string from an error
 * thrown by a token-endpoint mutation/action.
 *
 * Why this exists: the Convex runtime serialises a ConvexError thrown
 * from a `runAction`-nested mutation into the parent's caught `err` as
 * a regular `Error` whose `.message` is a wrapper string containing the
 * full inner serialised JSON plus the Convex source-location stack —
 * e.g.:
 *
 *   "Uncaught ConvexError: Uncaught ConvexError:
 *    {"code":"PKCE_MISMATCH","message":"code_verifier does not match..."}
 *        at handler (../../convex/oauth/tokens.ts:150:26)
 *        at async handler (../../convex/oauth/token.ts:88:17)"
 *
 * Passing that verbatim through `error_description` leaks Convex file
 * paths + line numbers on the wire, which is both noisy and an
 * information-disclosure issue. This helper:
 *
 * 1. If the caught error is a `ConvexError` instance with structured
 *    `data.message`, use that directly (happens when ConvexError is
 *    thrown at the top level of the httpAction, without a `runAction`
 *    boundary in between — rare on the token path, but safe).
 * 2. Otherwise extract the inner `"message":"..."` (and `"code":"..."`)
 *    from the wrapper string by regex. We deliberately match on the
 *    ConvexError's own JSON payload shape, not on the surrounding
 *    "Uncaught ConvexError:" prefix, so this is resilient to Convex
 *    runtime changes that tweak the wrapper text.
 * 3. Fallback to a constant "authorization grant is invalid" when no
 *    structured payload can be recovered — never leak raw `err.message`.
 */
function sanitizeTokenError(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { code?: string; message?: string } | undefined
    if (data?.message) return data.code ? `${data.code}: ${data.message}` : data.message
  }
  if (err instanceof Error) {
    const m = err.message.match(/"code"\s*:\s*"([^"]+)"\s*,\s*"message"\s*:\s*"([^"]+)"/)
    if (m) return `${m[1]}: ${m[2]}`
  }
  return 'authorization grant is invalid'
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

    // Pre-redirect-validation errors return a JSON 400 — we can't trust
    // the supplied redirect_uri yet, so we can't bounce the user-agent to
    // it (RFC 6749 §4.1.2.1, last paragraph).
    if (responseType !== 'code') return errorResponse(400, 'unsupported_response_type')
    if (!clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      return errorResponse(
        400,
        'invalid_request',
        'client_id, redirect_uri, code_challenge, code_challenge_method=S256 required',
      )
    }

    /**
     * Redirect the user-agent back to the client's redirect_uri with
     * OAuth-2.1 `error` / `error_description` / `state` query params.
     * Per RFC 6749 §4.1.2.1, this is the required shape for reporting
     * errors that occur AFTER the server has validated the redirect_uri
     * (the "user-agent-based error" form). `state` is echoed back
     * verbatim so the client can correlate with its original request.
     */
    const redirectError = (oauthError: string, description?: string): Response => {
      try {
        const target = new URL(redirectUri)
        target.searchParams.set('error', oauthError)
        if (description) target.searchParams.set('error_description', description)
        if (state) target.searchParams.set('state', state)
        return Response.redirect(target.toString(), 302)
      } catch {
        return errorResponse(400, oauthError, description)
      }
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
            : 'SERVER_ERROR'
        const errMsg =
          typeof data === 'object' &&
          data !== null &&
          'message' in data &&
          typeof (data as { message: unknown }).message === 'string'
            ? (data as { message: string }).message
            : err.message
        if (errCode === 'UNAUTHENTICATED') {
          // Bounce through Convex Auth's Google sign-in, then return here.
          // `convex/redirect.ts`'s `isAllowedRedirect` accepts our own
          // /authorize URL on the deployment origin, so the bounce-back is
          // permitted. If `signIn` itself errors (e.g. Google OAuth not
          // configured locally), fall through to the HTML fallback.
          try {
            const signInResult = (await ctx.runAction(api.auth.signIn, {
              provider: 'google',
              params: { redirectTo: req.url },
            })) as { redirect?: string } | undefined
            if (signInResult && typeof signInResult.redirect === 'string') {
              return Response.redirect(signInResult.redirect, 302)
            }
          } catch {
            /* fall through */
          }
          // The sign-in redirect path above failed — most commonly
          // because Google OAuth isn't configured on this deployment
          // (local dev without AUTH_GOOGLE_ID). Render a static
          // instructional page. Don't offer a "retry" link pointing at
          // the same /authorize URL: clicking it would re-enter this
          // same branch and produce the same 401 in a loop. We DO
          // preserve the original URL in the page text (HTML-escaped)
          // so the user can copy it after manual authentication.
          const escapedUrl = req.url
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
          return new Response(
            `<html><body><h2>Sign in required</h2>` +
              `<p>This cccollab deployment could not start a sign-in flow (Google OAuth may not be configured). ` +
              `Sign in to cccollab through your normal path, then re-issue this authorization request:</p>` +
              `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;">${escapedUrl}</pre>` +
              `</body></html>`,
            { status: 401, headers: { 'Content-Type': 'text/html' } },
          )
        }
        // RFC 6749 §4.1.2.1, last paragraph: if the server cannot verify
        // the redirect_uri — either because the client_id is unknown or
        // because the submitted redirect_uri isn't one of the registered
        // ones for the client — it MUST NOT redirect. Redirecting would
        // turn the authorization endpoint into an open-redirect gadget
        // that lets an unregistered attacker aim the user's browser at
        // any origin of their choice. Return a direct error response
        // instead.
        if (errCode === 'UNKNOWN_CLIENT' || errCode === 'INVALID_REDIRECT_URI') {
          return errorResponse(400, 'invalid_request', errMsg)
        }
        // For every other error, the redirect_uri has been validated
        // (issueAuthCode checks it before everything downstream), so
        // RFC 6749 §4.1.2.1 REQUIRES reporting the error via a redirect
        // to redirect_uri with `error=...&state=...`.
        const oauthError =
          errCode === 'INVALID_SCOPE'
            ? 'invalid_scope'
            : errCode === 'INVALID_REQUEST'
              ? 'invalid_request'
              : 'server_error'
        return redirectError(oauthError, errMsg)
      }
      return redirectError('server_error', err instanceof Error ? err.message : 'error')
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
    // Optional `client_name` is stored as part of the synthetic session
    // created on first token exchange; falling through without it would
    // produce "External MCP client (external/<id>)" for every AI client.
    const clientName = form.get('client_name') ?? undefined

    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? ''
      const codeVerifier = form.get('code_verifier') ?? ''
      const redirectUri = form.get('redirect_uri') ?? ''
      try {
        const tokens = await ctx.runAction(api.oauth.token.exchangeAuthCode, {
          clientId,
          clientSecret,
          clientName,
          code,
          codeVerifier,
          redirectUri,
        })
        return jsonResponse(tokens)
      } catch (err) {
        return errorResponse(400, 'invalid_grant', sanitizeTokenError(err))
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
        return errorResponse(400, 'invalid_grant', sanitizeTokenError(err))
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
