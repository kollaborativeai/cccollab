# Clerk OAuth Setup for cccollab CLI

Required for the `clerk` auth path against KAI's Convex deployment.
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

## On the Convex deployment

The CLI authenticates Convex with the Clerk **OIDC ID token** issued by the
OAuth flow. That token's `aud` claim is the OAuth **Client ID**, so the Convex
deployment must register a matching auth provider in `auth.config.ts`:

```ts
{ domain: process.env.CLERK_FRONTEND_API_URL, applicationID: process.env.CLERK_OAUTH_CLIENT_ID }
```

and `CLERK_OAUTH_CLIENT_ID` must be set on the deployment to the OAuth app's
Client ID (the same value as `clerkClientId` below). Convex verifies the ID
token offline against the Clerk JWKS — there is no token-exchange endpoint.
Dev and prod Clerk instances have different Client IDs, so set the value
per-deployment.

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
    "accessToken": "<oauth access token>",
    "idToken": "<oidc id token — the credential sent to Convex>",
    "accessTokenExpiresAt": 1715000000000
  }
}
```

The `idToken` is the token attached to Convex requests; the `accessToken` is
kept only to round-trip the OAuth session and is never sent to Convex. File
mode is `0600` (existing cccollab convention).
