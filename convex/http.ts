/**
 * Convex HTTP router.
 *
 * Only wires up Convex Auth's OAuth callback routes currently. The future HTTP
 * MCP server (see `docs/architecture/mcp-servers.md`) will register its own
 * routes here.
 */
import { httpRouter } from 'convex/server'

import { auth } from './auth'

const http = httpRouter()

auth.addHttpRoutes(http)

export default http
