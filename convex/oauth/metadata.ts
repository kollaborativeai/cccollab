import { ALLOWED_SCOPES } from './scopes'

/** Authorization-server metadata (RFC 8414). Served at
 *  `/.well-known/oauth-authorization-server` so MCP clients can discover
 *  the authorization + token endpoints without hard-coding them. */
export type AuthServerMetadata = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
  response_types_supported: string[]
  grant_types_supported: string[]
  code_challenge_methods_supported: string[]
  token_endpoint_auth_methods_supported: string[]
  scopes_supported: string[]
}

/** Protected-resource metadata (RFC 9728). Served at
 *  `/.well-known/oauth-protected-resource`; points the MCP client at the
 *  authorization server it should obtain tokens from. */
export type ProtectedResourceMetadata = {
  resource: string
  authorization_servers: string[]
  scopes_supported: string[]
  bearer_methods_supported: string[]
}

export function authServerMetadata(baseUrl: string): AuthServerMetadata {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: [...ALLOWED_SCOPES],
  }
}

export function protectedResourceMetadata(baseUrl: string): ProtectedResourceMetadata {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    scopes_supported: [...ALLOWED_SCOPES],
    bearer_methods_supported: ['header'],
  }
}
