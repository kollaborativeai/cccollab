#!/usr/bin/env bash
# Launch Claude Code in this test project with the local-dev plugin's
# channel attached. Run from anywhere:
#   ./test/start.sh
#   ./test/start.sh right          # pre-seeds CCCOLLAB_NAME=right
# or from this dir:
#   ./start.sh left
#
# CCCOLLAB_OBJECTIVE set in the parent shell is inherited automatically and
# pre-seeds the session's objective alongside CCCOLLAB_NAME.
set -euo pipefail
cd "$(dirname "$0")"
clear

# Defensively scrub any SLACK_* vars from the parent shell. The local-only MVP
# has no Slack runtime; this guarantees the harness can't pick up real creds.
for var in "${!SLACK_@}"; do unset "$var"; done

# If the first positional arg is a bare word (not a flag), treat it as the
# session name and expose it via CCCOLLAB_NAME so cccollab pre-seeds identity.
NAME=""
if [[ $# -gt 0 && "$1" != -* ]]; then
  NAME="$1"
  export CCCOLLAB_NAME="$NAME"
  shift
fi

if [[ -n "$NAME" ]]; then
  exec claude \
    --dangerously-skip-permissions \
    --dangerously-load-development-channels plugin:cccollab@cccollab-test \
    -n "$NAME" \
    "$@"
else
  exec claude \
    --dangerously-skip-permissions \
    --dangerously-load-development-channels plugin:cccollab@cccollab-test \
    "$@"
fi
