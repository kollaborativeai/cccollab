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

# 3. Idempotently configure ~/.npmrc for @kollaborativeai scope
NPMRC="${HOME}/.npmrc"
TOKEN=$(gh auth token)
touch "$NPMRC"

if ! grep -q "^@kollaborativeai:registry=" "$NPMRC"; then
  log "Adding @kollaborativeai registry to ~/.npmrc"
  echo "@kollaborativeai:registry=https://npm.pkg.github.com" >> "$NPMRC"
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
log "Installing @kollaborativeai/cccollab..."
npm i -g @kollaborativeai/cccollab

# 5. Retire any pre-rebrand install of cccollab@flatoutsolutions.
#    Only the plugin is removed: the marketplace it came from also serves
#    unrelated plugins (development, jira, ...), so unregistering it would
#    break them.
if claude plugin list 2>/dev/null | grep -q "cccollab@flatoutsolutions"; then
  log "Removing the old cccollab@flatoutsolutions plugin..."
  claude plugin uninstall cccollab@flatoutsolutions || true
fi

# 6. Ensure the kollaborativeai marketplace is registered with Claude Code
if ! claude plugin marketplace list 2>/dev/null | grep -q "^  ❯ kollaborativeai$"; then
  log "Adding kollaborativeai marketplace to Claude Code..."
  claude plugin marketplace add kollaborativeai/cccollab
else
  log "kollaborativeai marketplace already registered."
fi

# 7. Install the plugin (auto-registers the MCP server and bundles the usage skill)
log "Installing the cccollab plugin..."
claude plugin install cccollab@kollaborativeai

log "Done."
cat <<'EOF'

Next step:
  Start Claude Code. cccollab works out of the box:

  - Local mode (two sessions on the same machine) needs no setup.
  - Upgrading from cccollab@flatoutsolutions? The old plugin was
    uninstalled above, but a shell alias or ~/.claude/settings.json
    pinned to it still points at the retired name. Swap any
    `plugin:cccollab@flatoutsolutions` for
    `plugin:cccollab@kollaborativeai`.
  - The hosted backend at collab.kollaborativeai.com is wired in by
    default — just run the `authenticate` MCP tool inside Claude Code
    to sign in with your KAI account.

  Self-hosting? See docs/architecture/clerk-auth-setup.md for the
  override path: declare your own location under `locations.<name>`
  in ~/.cccollab/config.json.

EOF
