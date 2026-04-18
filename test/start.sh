#!/usr/bin/env bash
# Launch Claude Code in this test project with the local-dev plugin's
# channel attached. Run from anywhere:
#   ./test/start.sh
# or from this dir:
#   ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
exec claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels plugin:claudecode-slack-collab@claudecode-slack-collab-test \
  "$@"
