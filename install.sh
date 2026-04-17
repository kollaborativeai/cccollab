#!/usr/bin/env bash
set -euo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Prereq checks
command -v gh >/dev/null 2>&1 || err "GitHub CLI (gh) is required. Install: https://cli.github.com"
command -v npm >/dev/null 2>&1 || err "npm is required (install Node.js 20+)."
command -v claude >/dev/null 2>&1 || err "claude (Claude Code CLI) is required. Install: https://claude.com/claude-code"

gh auth status >/dev/null 2>&1 || err "gh is not authenticated. Run: gh auth login"

# 2. Ensure read:packages scope on gh token
if ! gh auth status 2>&1 | grep -q "read:packages"; then
  log "Adding read:packages scope to your GitHub CLI token (browser consent may open)..."
  gh auth refresh -s read:packages
fi

# 3. Idempotently configure ~/.npmrc for @flatoutsolutions scope
NPMRC="${HOME}/.npmrc"
TOKEN=$(gh auth token)
touch "$NPMRC"

if ! grep -q "^@flatoutsolutions:registry=" "$NPMRC"; then
  log "Adding @flatoutsolutions registry to ~/.npmrc"
  echo "@flatoutsolutions:registry=https://npm.pkg.github.com" >> "$NPMRC"
fi

if grep -q "^//npm.pkg.github.com/:_authToken=" "$NPMRC"; then
  log "Refreshing npm.pkg.github.com auth token in ~/.npmrc"
  # Use a portable in-place edit (BSD and GNU sed)
  tmpfile=$(mktemp)
  sed "s|^//npm.pkg.github.com/:_authToken=.*|//npm.pkg.github.com/:_authToken=${TOKEN}|" "$NPMRC" > "$tmpfile"
  mv "$tmpfile" "$NPMRC"
else
  log "Adding npm.pkg.github.com auth token to ~/.npmrc"
  echo "//npm.pkg.github.com/:_authToken=${TOKEN}" >> "$NPMRC"
fi

# 4. Install the npm package globally
log "Installing @flatoutsolutions/claudecode-slack-collab..."
npm i -g @flatoutsolutions/claudecode-slack-collab

# 5. Ensure the flatoutsolutions marketplace is registered with Claude Code
if ! claude plugin marketplace list 2>/dev/null | grep -q "^  ❯ flatoutsolutions$"; then
  log "Adding flatoutsolutions marketplace to Claude Code..."
  claude plugin marketplace add flatoutsolutions/ai_instructions
else
  log "flatoutsolutions marketplace already registered."
fi

# 6. Install the plugin (auto-registers the MCP server and bundles the usage skill)
log "Installing the claudecode-slack-collab plugin..."
claude plugin install claudecode-slack-collab@flatoutsolutions

log "Done."
cat <<'EOF'

Next step:
  Start Claude Code, then call the `authenticate` tool. A browser will open
  for Slack OAuth. Authorize, restart the session, and you're ready to use
  the /introduce, /start_topic, /send_message tools.

EOF
