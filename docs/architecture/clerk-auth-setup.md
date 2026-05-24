# Self-Hosting / Override: Clerk OAuth Setup

**You do NOT need this for the default install** — the cccollab MCP server ships with the production Clerk app pointer and proxy URL baked in (see `docs/config.md` → Defaults). Use this page only if you want to point cccollab at your own Convex deployment + Clerk app (self-hosting, CI fixtures, second Clerk environment, etc.).

One-time setup per Clerk environment (dev / prod).

## In Clerk Dashboard

1. Navigate to **Configure → OAuth Applications**.
2. Click **Add OAuth application**:
   - **Name:** `cccollab-cli`
   - **Client type:** Public (no client secret)
   - **Require PKCE:** Yes (S256)
   - **Authorized redirect URL:** `http://127.0.0.1:53682/cccollab-oauth-callback` — **exact URL, no wildcards**. Clerk's dashboard rejects wildcards in the port position (RFC 8252 §7.3 non-compliance). If port 53682 collides with another local service, pick a different port and:
     1. Register the alternate URL in Clerk (e.g. `http://127.0.0.1:54321/cccollab-oauth-callback`)
     2. Add `"clerkRedirectPort": 54321` to your location config (see "Per-user config" below).
   - **Scopes:** `openid profile email`
3. Note the **Issuer URL** (e.g. `https://your-instance.clerk.accounts.dev` or `https://clerk.your-domain.com`).
4. Note the **Client ID** (will be the literal `cccollab-cli` or a generated id — copy whatever Clerk produces).

## In Clerk JWT Templates

Verify the `convex` template exists. KAI already uses it for the web app — the same template works for the CLI.

If you need to add it: template name `convex`, audience `convex`, lifetime ≤ 60s.

## Per-user config

End users put this in `~/.cccollab/config.json`:

```jsonc
{
  "locations": {
    "kai": {
      "url": "https://<kai-deployment>.convex.cloud",
      "clerkIssuer": "https://<clerk-instance>.clerk.accounts.dev",
      "clerkClientId": "cccollab-cli",
      // Optional: override the default loopback port (53682).
      // Must match the URL allowlisted in Clerk Dashboard.
      // "clerkRedirectPort": 54321
    },
  },
}
```

`authType: "clerk"` is also accepted (and is what the `authenticate` tool
writes alongside the tokens — see below), but is optional today since
Clerk is the only auth flow.

After running `authenticate --location kai`, tokens are appended by the CLI:

```json
{
  "kai": {
    "url": "...",
    "authType": "clerk",
    "clerkIssuer": "...",
    "clerkClientId": "cccollab-cli",
    "refreshToken": "<rt>",
    "accessToken": "<short-lived jwt>",
    "accessTokenExpiresAt": 1715000000000
  }
}
```

File mode is `0600` (existing cccollab convention).
