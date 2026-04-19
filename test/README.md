# cccollab test harness

Manual end-to-end walkthrough for the local-only MVP. Two Claude Code sessions
auto-join a shared local channel, discover each other, exchange direct messages,
and converse inside a shared topic - all without any Slack credentials present
and zero `slack.com` traffic.

## Prereqs

From the repo root, once:

```bash
yarn install
npm link         # repoint the global `cccollab` binary at this repo so the harness exercises local src/ (instead of the published @flatoutsolutions/cccollab from install.sh)
claude plugin marketplace add ./test-marketplace
claude plugin install cccollab@cccollab-test
```

`test/.claude/settings.json` enables `cccollab@cccollab-test` and disables the
production `cccollab@flatoutsolutions` plugin so the two never collide in this
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
- Exports `CCCOLLAB_NAME=<positional>` so the session pre-seeds its identity.
- Runs `claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:cccollab@cccollab-test -n <name>`.

`test/.cccollab.json` pins both sessions to:

```json
{
  "profile": "test",
  "default_channels": ["cccollab-test"]
}
```

The `profile: "test"` value gives the harness its own per-profile broker socket
(`~/.cccollab/run/test/`), isolated from any developer's real `cccollab`
profile. The `default_channels` value subscribes both sessions to
`cccollab-test` on startup.

## Verification

### 1. Identity and channels

In `left`, ask Claude to call `whoami`. Expect:

- `name: "left"`
- `objective`: present only if you exported `CCCOLLAB_OBJECTIVE`
- `subscribedChannels` includes `{ name: "cccollab-test", source: "cccollab.json" }`

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

### 3. Direct message

From `left`, call `send_message_to_session(to: "right", text: "ping")`.
Confirm `right` receives it as a `<channel source="cccollab" ...>` event tagged
with the channel and sender.

### 4. Topic

In `left`: `start_topic("demo")`. In `right`: `join_topic("demo")`. Both then
call `send_message_to_topic("hello from <name>")`. Each session should see the
other's message arrive as a channel event scoped to the `demo` topic.

### 5. Zero Slack traffic

The runtime has no Slack code post-CCC-28. Verify from the repo root:

```bash
grep -r "@slack" src/                                                    # expect: no output
node -e "const p=require('./package.json'); console.log(Object.keys(p.dependencies).filter(k=>k.startsWith('@slack')))"
                                                                         # expect: []
```

While both sessions are running, runtime spot-check:

```bash
lsof -i -nP 2>/dev/null | grep -i slack                                  # expect: no output
```

## Customizing per-session objective

`CCCOLLAB_OBJECTIVE` set in the parent shell flows through `exec claude`
automatically and is read by `src/initial-identity.ts`:

```bash
CCCOLLAB_OBJECTIVE="be the picky reviewer" ./test/start.sh left
```

`whoami` should now report that objective.

## Cleanup

Quit each Claude Code session (Ctrl+C). The broker is per-profile and shuts
down when its last session disconnects; no stray daemons.
