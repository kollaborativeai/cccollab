# cccollab test harness

Manual end-to-end walkthrough for the local-only MVP. Two Claude Code sessions
auto-join a shared local channel, discover each other, broadcast on the channel,
and converse inside a shared topic - all without any Slack credentials present
and zero `slack.com` traffic.

## Prereqs

From the repo root, once:

```bash
yarn install
claude plugin marketplace add ./test-marketplace
claude plugin install cccollab@cccollab-test
```

No `npm link` - that would replace the global `cccollab` binary on PATH and
break every production cccollab session on the machine. Instead, `test/start.sh`
prepends this repo's `mcp_server/bin/` to PATH for just the test session, so
the spawned MCP server resolves to local `mcp_server/src/` via tsx while
production sessions outside the harness keep using the globally installed
`@kollaborativeai/cccollab`.

`test/.claude/settings.json` enables `cccollab@cccollab-test` and disables the
production `cccollab@kollaborativeai` plugin so the two never collide in this
project.

## Launching two sessions

Open two terminals. In each, from anywhere in the repo:

```bash
# terminal 1
./test/start.sh left

# terminal 2
./test/start.sh right
```

Each launch:

- `cd`s into `test/`, so `.cccollab.json` is found by walking up from `cwd`.
- Prepends the repo's `mcp_server/bin/` to PATH so the spawned MCP server resolves to local `mcp_server/src/` via tsx, not the global install.
- Exports `CCCOLLAB_PROFILE=test` to isolate the harness's broker socket from any developer's real cccollab profile.
- Exports `CCCOLLAB_NAME=<positional>` so the session pre-seeds its identity.
- Runs `claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:cccollab@cccollab-test -n <name>`.

`test/.cccollab.json` pins both sessions to a shared local channel:

```json
{
  "locations": {
    "local": {
      "active": true,
      "channels": {
        "cccollab-test": {
          "active": true
        }
      }
    }
  }
}
```

`locations.local.channels.cccollab-test` subscribes both sessions to that
channel on startup. The per-profile broker socket (`~/.cccollab/run/test/`)
that isolates the harness from any production session comes from the
`CCCOLLAB_PROFILE=test` env var exported by `start.sh`, not from this
file. Full schema: `mcp_server/src/config/schema.ts`.

## Verification

### 1. Identity and channels

In `left`, ask Claude to call `whoami`. Expect:

- `name: "left"`
- `objective`: present only if you exported `CCCOLLAB_OBJECTIVE`
- `subscribedChannels` includes `{ name: "cccollab-test", location: "local", source: "cccollab.json" }`

Repeat in `right`, expecting `name: "right"`. Env-var name beats any `name`
in `.cccollab.json` per the loader precedence.

The active profile is not in `whoami` output. Confirm both sessions are on the
`test` profile by checking the per-profile broker socket exists at
`~/.cccollab/run/test/`.

### 2. Peer discovery

In `left`, call `list_sessions`. Expect `right` in the list (and vice versa).
If they don't see each other, the most likely cause is a profile mismatch -
the broker is per-profile, so check that `~/.cccollab/run/test/` is the only
recently-active profile dir while both sessions are running.

### 3. Channel broadcast

From `left`, call `send_message_to_channel(text: "ping")` on the shared channel.
Confirm `right` receives it as a `<channel source="cccollab" ...>` event tagged
with the channel and sender.

### 4. Topic

In `left`: `start_topic("demo")`. In `right`: `join_topic("demo")`. Both then
call `send_message_to_topic("hello from <name>")`. Each session should see the
other's message arrive as a channel event scoped to the `demo` topic.

### 5. Zero Slack traffic

The runtime has no Slack code. Verify from the repo root:

```bash
grep -r "@slack" mcp_server/src/                                          # expect: no output
node -e "const p=require('./mcp_server/package.json'); console.log(Object.keys({...p.dependencies, ...p.devDependencies}).filter(k=>k.startsWith('@slack')))"
                                                                         # expect: []
```

While both sessions are running, runtime spot-check:

```bash
lsof -i -nP 2>/dev/null | grep -i slack                                  # expect: no output
```

## Customizing per-session objective

`CCCOLLAB_OBJECTIVE` set in the parent shell flows through `exec claude`
automatically and is read by `mcp_server/src/config/env.ts`:

```bash
CCCOLLAB_OBJECTIVE="be the picky reviewer" ./test/start.sh left
```

`whoami` should now report that objective.

## Cleanup

Quit each Claude Code session (Ctrl+C). The broker is per-profile and shuts
down when its last session disconnects; no stray daemons.
