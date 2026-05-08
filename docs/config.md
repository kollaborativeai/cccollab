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
  hold OAuth tokens. It's the file the `authenticate` tool writes to.
- The project-level file (`.cccollab.json`) is discovered by walking up
  from the session's cwd. It's meant to be committed to the repo. Auth
  fields (`accessToken`, `refreshToken`, `userEmail`, `userId`,
  `updatedAt`) are silently stripped from project-level configs - each
  stripped field logs a warning once so you notice and move the secret to
  the user file.
- Environment variables apply after the merge, so they always win.

## Schema

```ts
{
  name?: string              // session display name
  objective?: string         // what this session is working on
  locations?: {
    [locationName: string]: {
      url?: string           // required on every non-local location
      active?: boolean       // cascading active flag (see below)
      accessToken?: string   // persisted OAuth token (user file only)
      refreshToken?: string  // persisted OAuth token (user file only)
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
hold `accessToken`, `refreshToken`, `userEmail`, `userId`, and `updatedAt`
under `locations.flatout`. These fields are written by the tool; don't
edit them by hand.

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

| Variable              | Effect                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CCCOLLAB_NAME`       | Overrides the top-level `name`.                                                                                                                                                           |
| `CCCOLLAB_OBJECTIVE`  | Overrides the top-level `objective`.                                                                                                                                                      |
| `CCCOLLAB_REMOTE_URL` | Registers (or updates) a location named `remote` with this URL and marks it active. Every other location's `active` flag is cleared so "exactly one active location" holds.               |
| `CCCOLLAB_AUTH_TOKEN` | Assigns this value as `accessToken` on the env-registered `remote` (if `CCCOLLAB_REMOTE_URL` is set this pass) or on the first existing non-local location with `active: true` otherwise. |
| `CCCOLLAB_PROFILE`    | Keys the local broker's runtime state. Sessions with the same profile share the same broker; different profiles stay isolated. Affects only the local transport.                          |

## Reserved `local` location

- Always implicitly available. You do not need to declare it.
- Must not have a `url`. Setting one is ignored.
- Auth fields on the `local` location are ignored (the local broker has no
  authentication).
- If you declare channels or topics under `local` they auto-subscribe
  exactly like any other location's channels and topics.

## Auth fields recognised only on the user-level file

- `accessToken` - OAuth bearer token used by the remote transport.
- `refreshToken` - single-use refresh token; the client rewrites it on
  every refresh round-trip.
- `userEmail` - set at sign-in; surfaced in `whoami`'s "Signed in as" line.
- `userId` - optional, matches the Convex user row.
- `updatedAt` - millisecond timestamp of the last token write; used for
  diagnostics.

All five fields are stripped from any `.cccollab.json` before merging. The
authenticate tool writes them atomically with mode `0600` on the
user-level file.
