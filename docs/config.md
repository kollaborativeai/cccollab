# cccollab config reference

cccollab reads its configuration from two files, plus a handful of
environment variables for one-off overrides. All fields are optional. When
nothing is configured, cccollab runs in local-only mode with a session
identity pulled from the environment (or prompted for via `introduce`).

## File layering

```
┌─────────────────────────────────┐     highest precedence
│ env vars (per-invocation)       │     (CCCOLLAB_*)
├─────────────────────────────────┤
│ .cccollab.json                  │     project-level, walked up from cwd
│   (no credentials allowed)      │
├─────────────────────────────────┤
│ ~/.cccollab/config.json         │     user-level, allowed to hold secrets
└─────────────────────────────────┘     lowest precedence
```

- The user-level file (`~/.cccollab/config.json`) is the only file that may
  hold auth tokens. It's the file the `authenticate` tool writes to.
- The project-level file (`.cccollab.json`) is discovered by walking up
  from the session's cwd. It's meant to be committed to the repo. Auth
  credential fields (`accessToken`, `refreshToken`, `accessTokenExpiresAt`,
  `userEmail`, `userId`, `updatedAt`) are silently stripped from
  project-level configs - each stripped field logs a warning once so you
  notice and move the secret to the user file. The Clerk **app pointer**
  fields (`authType`, `clerkIssuer`, `clerkClientId`, `clerkRedirectPort`)
  are configuration, not credentials, so they are kept on project-level
  configs and shared via source control.
- Environment variables apply after the merge, so they always win.

## Schema

```ts
{
  name?: string                  // session display name
  objective?: string             // what this session is working on
  locations?: {
    [locationName: string]: {
      url?: string               // required on every non-local location
      active?: boolean           // cascading active flag (see below)

      // Reserved auth-flow discriminator. Optional; only 'clerk' is
      // accepted today, and Clerk is the only auth flow, so this is
      // informational. The `authenticate` tool writes it alongside the
      // persisted tokens.
      authType?: 'clerk'

      // Clerk app pointer. clerkIssuer + clerkClientId are required at
      // the use-site (the resolved location must carry both, though
      // they may be split between project-level and user-level files).
      clerkIssuer?: string
      clerkClientId?: string
      clerkRedirectPort?: number // override the default loopback port (53682)

      // Credentials - written by `authenticate`, user-level file only.
      accessToken?: string
      refreshToken?: string
      accessTokenExpiresAt?: number // ms-epoch expiry of accessToken (clerk)
      userEmail?: string
      userId?: string
      updatedAt?: number

      channels?: {
        [channelName: string]: {
          active?: boolean
          topics?: {
            [topicName: string]: {
              active?: boolean
            }
          }
        }
      }
    }
  }
}
```

Every key is a free-form identifier. Reserved names:

- `"local"` under `locations` refers to the in-process per-machine broker.
  It is always implicitly available even when not declared in any config
  file. A `local` entry in the config is accepted but must not have a
  `url`.

A non-local location must resolve to a shape that includes `clerkIssuer`
and `clerkClientId`. Those two fields may be split between the
project-level `.cccollab.json` and the user-level `~/.cccollab/config.json`

- they are merged before validation - but the resolved location must
  have both. `authType: "clerk"` is accepted and written by the
  `authenticate` tool, but is optional and informational: Clerk is the
  only auth flow today, so the field is a reserved slot for future
  providers rather than a discriminator that's checked at runtime.

## Active-state cascade

`active: true` may be set at any of three levels (location, channel, topic)
and cascades upward:

- An active topic marks its channel and its location active.
- An active channel marks its location active.
- An explicit `active: true` at a level is honoured directly.
- Having zero actives at a level is fine.
- Having two or more actives at the same level is an error; cccollab
  names the offenders at resolve time.

Example: a config that sets only `locations.flatout.channels.dev.topics.planning.active = true`
resolves to an active location of `flatout`, an active channel of `dev`,
and an active topic of `planning`.

## Example: FS-internal user with one local + one remote

`~/.cccollab/config.json`:

```json
{
  "name": "architect",
  "objective": "Review PRs for the platform monorepo",
  "locations": {
    "local": {
      "channels": {
        "team": {
          "active": true
        }
      }
    },
    "flatout": {
      "url": "https://wonderful-narwhal-409.convex.cloud",
      "clerkIssuer": "https://<your-instance>.clerk.accounts.dev",
      "clerkClientId": "cccollab-cli",
      "channels": {
        "cccollab": {
          "topics": {
            "general": {}
          }
        }
      }
    }
  }
}
```

After `authenticate({ location: "flatout" })`, the same file will also
hold `accessToken`, `refreshToken`, `accessTokenExpiresAt`, `userEmail`,
`userId`, and `updatedAt` under `locations.flatout`. These fields are
written by the tool; don't edit them by hand.

## Example: project-level `.cccollab.json`

A team repo that wants every clone to land in the same channel and topic
can commit a project-level config:

```json
{
  "name": "platform-reviewer",
  "objective": "Review PRs for the platform monorepo",
  "locations": {
    "local": {
      "channels": {
        "platform": {
          "topics": {
            "planning": { "active": true }
          }
        }
      }
    }
  }
}
```

Because this file is committed, do not put an `accessToken` here - any auth
field will be stripped at load time and a warning logged.

## Environment variable overrides

All env vars are applied after file merging and win over anything on disk.

| Variable                   | Effect                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CCCOLLAB_NAME`            | Overrides the top-level `name`.                                                                                                                                             |
| `CCCOLLAB_OBJECTIVE`       | Overrides the top-level `objective`.                                                                                                                                        |
| `CCCOLLAB_REMOTE_URL`      | Registers (or updates) a location named `remote` with this URL and marks it active. Every other location's `active` flag is cleared so "exactly one active location" holds. |
| `CCCOLLAB_CLERK_ISSUER`    | Sets `clerkIssuer` on the env-registered `remote` (if `CCCOLLAB_REMOTE_URL` is set this pass) or on the first existing non-local location with `active: true` otherwise.    |
| `CCCOLLAB_CLERK_CLIENT_ID` | Same target as `CCCOLLAB_CLERK_ISSUER`; sets `clerkClientId`. Set both alongside `CCCOLLAB_REMOTE_URL` for a complete, on-disk-free remote-location declaration.            |
| `CCCOLLAB_PROFILE`         | Keys the local broker's runtime state. Sessions with the same profile share the same broker; different profiles stay isolated. Affects only the local transport.            |

## Reserved `local` location

- Always implicitly available. You do not need to declare it.
- Must not have a `url`. Setting one is ignored.
- Auth fields on the `local` location are ignored (the local broker has no
  authentication).
- If you declare channels or topics under `local` they auto-subscribe
  exactly like any other location's channels and topics.

## Auth fields recognised only on the user-level file

- `accessToken` - bearer token used by the remote transport.
- `refreshToken` - refresh token; the client rewrites it on every refresh
  round-trip.
- `accessTokenExpiresAt` - millisecond-epoch expiry of the short-lived
  `accessToken` (Clerk only).
- `userEmail` - set at sign-in; surfaced in `whoami`'s "Signed in as" line.
- `userId` - optional, matches the user row on the backend.
- `updatedAt` - millisecond timestamp of the last token write; used for
  diagnostics.

All six fields are stripped from any `.cccollab.json` before merging. The
authenticate tool writes them atomically with mode `0600` on the
user-level file.

The Clerk app pointer fields (`authType`, `clerkIssuer`, `clerkClientId`,
`clerkRedirectPort`) are **not** credentials and are **not** stripped from
the project-level file - they're meant to be shared via source control so
every developer in a team picks up the same Clerk app configuration.
