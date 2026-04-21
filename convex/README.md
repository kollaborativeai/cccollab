# cccollab Convex Backend

Hosts the HTTP MCP server for [CCC-22](https://flatoutsolutions.atlassian.net/browse/CCC-22): external AI clients (Claude.ai, ChatGPT, Cursor, Gemini) can connect to cccollab topics via OAuth 2.1, read transcripts, and post messages.

## Layout

- `schema.ts` — database schema
- `auth.config.ts` — Clerk JWT issuer config
- `http.ts` — HTTP router (all public endpoints)
- `users.ts` / `channels.ts` / `topics.ts` / `messages.ts` — core domain
- `oauth/` — OAuth 2.1 authorization server (register, authorize, token, metadata)
- `mcp/` — MCP streamable HTTP transport (dispatcher + tools)
- `lib/` — small helpers (crypto, http, time)
- `tests/` — convex-test based unit/integration tests

## Development

```bash
npx convex dev        # local dev server (requires Convex account)
npx convex codegen    # regenerate _generated/ without deploying
```

## Testing

Convex functions are exercised with `convex-test` in-memory; see `tests/*.test.ts`.

```bash
yarn test
```

## Environment

See `.env.example` at the repo root.
