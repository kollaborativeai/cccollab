# Hand test — KAI-415, session subscription restore

Manual verification that a restarted session gets its channels and topics back.

**Every command and every output below was executed on `e2183a8`. Nothing here is
predicted.** Where a check has a trap that makes it prove less than it appears to,
the trap is called out rather than left for the reader to fall into. Where something
is *not* covered, it says so — see [What this does not cover](#what-this-does-not-cover).

## Setup

Run from `mcp_server/`, with an isolated `HOME` so the test cannot touch your real
subscriptions. State lands in `$HOME/.cccollab/sessions/<sessionId>.json`.

```bash
cd mcp_server
export HT=/tmp/kai-415-ht          # scratch HOME
export DRIVE=../docs/hand-tests/kai-415-drive.mjs
rm -rf "$HT" && mkdir -p "$HT"
```

No build step: the driver runs the server through `npx tsx src/server.ts`.

---

## Check 1 — a restarted session gets its subscriptions back

> **The trap.** The `cccollab` channel is auto-subscribed from config on every
> start. If you test with it and it reappears after a restart, **you have proved
> nothing** — config would have re-added it with no persistence at all. Confusing
> those two paths is the whole substance of KAI-428. Use a channel config does not
> know about, and read the `source` field, which is what tells them apart.

**Run 1 — join a channel config has never heard of, and start a topic:**

```bash
export SID=11111111-2222-3333-4444-555555555555
HOME=$HT node $DRIVE $SID \
  'join_channel|{"name":"handtest-415"}' \
  'start_topic|{"topic":"Restore me","channel":"handtest-415"}'
```

Observed:

```
MCP initialize: OK
--- join_channel
{"channel":"handtest-415","location":"local","becameActive":false,"subscriberCount":1}
--- start_topic
{"id":"6367b060-2309-492e-b1b5-9e59a2ca1582","name":"Restore me","channel":"handtest-415","location":"local"}
```

The process is now dead. Inspect what it left behind (topic ids and `updatedAt` are
generated per run — yours will differ from the values shown here):

```bash
cat "$HT/.cccollab/sessions/$SID.json"
```

```json
{
  "version": 1,
  "sessionId": "11111111-2222-3333-4444-555555555555",
  "channels": [
    { "name": "cccollab",     "location": "local", "source": "cccollab.json" },
    { "name": "handtest-415", "location": "local", "source": "manual" }
  ],
  "topics": [
    { "id": "6367b060-2309-492e-b1b5-9e59a2ca1582", "name": "Restore me",
      "channel": "handtest-415", "location": "local" }
  ],
  "activeChannel": { "name": "cccollab", "location": "local" },
  "activeTopic": "6367b060-2309-492e-b1b5-9e59a2ca1582",
  "updatedAt": 1784154701456
}
```

**Run 2 — same session id, brand-new process:**

```bash
HOME=$HT node $DRIVE $SID 'whoami'
```

Observed (`subscribedChannels`, reformatted for reading):

```
[stderr] [cccollab] Restored 2 channel(s) and 1 topic(s) from previous session

channel     : cccollab     | source = cccollab.json   <- config did this. Proves nothing.
channel     : handtest-415 | source = restored        <- THE CHECK. Only restore can explain it.
activeTopic : {"name":"Restore me","channel":"handtest-415","location":"local"}
```

**PASS** when `handtest-415` is present with `source = restored`. That channel is in
no config file, so nothing but the restore path can put it there.

Two details that look wrong and are not:

- The count says **2 channels** restored, not 1. Restore rebuilds both channels in the
  state file, `cccollab` included. `cccollab` then reports `source = cccollab.json`
  because config auto-subscribe also claims it — which is exactly why its presence
  after a restart is worthless as evidence, and why this check reads `handtest-415`.
- Re-run `whoami` and the state file now records `handtest-415` with
  `source = "restored"` rather than `"manual"`: run 2 re-snapshotted what it restored.
  Expected. `"manual"` is what run 1 wrote.

## Check 2 — a malformed session id degrades, it does not brick startup

The id arrives from the environment and lands in a file path. It must never address
a file outside the sessions dir, and refusing it must not take the server down with
it — that regression made the plugin unusable, not merely forgetful.

```bash
for SID in '../../pwned' 'a/b' '   '; do
  echo "##### $SID"
  HOME=$HT node $DRIVE "$SID" 'whoami' 2>&1 | grep -E 'initialize|Could not persist|Fatal'
done
```

Observed:

```
##### ../../pwned
[stderr] [cccollab] Could not persist session state: cccollab: refusing to use "../../pwned" as a session id in a file path
MCP initialize: OK
##### a/b
[stderr] [cccollab] Could not persist session state: cccollab: refusing to use "a/b" as a session id in a file path
MCP initialize: OK
#####
MCP initialize: OK
```

```bash
find "$HT" -name '*pwned*'     # -> no output
ls "$HT/.cccollab/sessions/"   # -> only well-formed uuid .json files
```

**PASS** when every id prints `MCP initialize: OK` (the server answered — it did not
die), the rejection is *reported* rather than swallowed, and `find` returns nothing.
A `Fatal error` line, or no `initialize` line at all, is the regression.

Note the blank id `'   '` prints no warning: no id means nothing to persist, which is
not a failure to report.

## Check 3 — restore does not invent an active topic

Rejoining topics focuses each one as a side effect, so a naive restore ends with one
topic arbitrarily active — including for a session that had none. Reproduce the state
by hand, because no tool un-focuses a topic without also leaving it:

```bash
export SID=99999999-8888-7777-6666-555555555555
HOME=$HT node $DRIVE $SID \
  'join_channel|{"name":"handtest-415"}' \
  'start_topic|{"topic":"Topic A","channel":"handtest-415"}' \
  'start_topic|{"topic":"Topic B","channel":"handtest-415"}'

# Simulate a session that had topics joined but none focused.
python3 - "$HT/.cccollab/sessions/$SID.json" <<'EOF'
import json, sys
f = sys.argv[1]; s = json.load(open(f))
s.pop('activeTopic', None)
json.dump(s, open(f, 'w'), indent=2)
EOF

HOME=$HT node $DRIVE $SID 'whoami'
```

Observed:

```
[stderr] [cccollab] Restored 2 channel(s) and 2 topic(s) from previous session
{"name":"cccollab maintainer", ... ,"subscribedChannels":[...]}
```

**PASS** when the stderr line reports **2 topic(s) restored** and the `whoami` payload
has **no `activeTopic` key at all**. Both topics came back; neither was focused.

> **The trap.** `whoami` does not expose a `joinedTopics` field — only `activeTopic`,
> and only when one is active. Do not read "topics are missing" into its absence; that
> misreading says the restore failed when it succeeded. The stderr `Restored N
> topic(s)` line is the evidence that topics were rejoined. This bit me while writing
> this doc.

## Check 4 — file hygiene and isolation

```bash
stat -c '%a %n' "$HT/.cccollab/sessions/"*.json
```

```
600 /tmp/kai-415-ht/.cccollab/sessions/11111111-2222-3333-4444-555555555555.json
600 /tmp/kai-415-ht/.cccollab/sessions/99999999-8888-7777-6666-555555555555.json
```

**PASS** on mode `600` (the file records where a session has been — it is not
world-readable), one file per session id, and each file holding only its own state:

```
11111111 -> ['cccollab', 'handtest-415'] | topics: 1
99999999 -> ['cccollab', 'handtest-415'] | topics: 2
```

Two sessions, two files, neither clobbering the other.

## Cleanup

```bash
rm -rf "$HT"
```

The `handtest-415` channel and its topics stay on your **local broker**; the isolated
`HOME` does not contain them. They are inert, but `list_channels` will show them.

---

## What this does not cover

Stated plainly, because a hand-test doc that implies more coverage than it has is
worse than none.

- **The real Claude Code plugin path.** This drives the MCP server directly over
  stdio. It does not exercise Claude Code spawning the plugin, which is where
  `CLAUDE_CODE_SESSION_ID` actually comes from.
- **Remote transports.** Every check above runs against `local` only. The
  disabled-transport and multi-location restore paths are covered by unit tests, not
  here.
- **Archived-topic skip.** That a topic archived before the restart is not
  resurrected is covered in `session-restore.integration.test.ts` against a real
  broker. Reproducing it by hand needs a second session to do the archiving.
- **Concurrency.** Round 1's review raced 800 concurrent writes with 0 torn reads.
  Not reproducible by hand; see the automated suite.
