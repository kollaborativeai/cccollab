#!/usr/bin/env bash
set -euo pipefail

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
err() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# 1. Prereqs
command -v node >/dev/null 2>&1 || err "Node.js 20+ is required. Install: https://nodejs.org"
command -v npm >/dev/null 2>&1 || err "npm is required (ships with Node.js)."
command -v claude >/dev/null 2>&1 || err "claude (Claude Code CLI) is required. Install: https://claude.com/claude-code"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || err "Node.js 20+ is required (found $(node --version))."

# 2. Remove the scope mapping written by the pre-npmjs installer.
#
#    Earlier versions of this script wrote
#      @kollaborativeai:registry=https://npm.pkg.github.com
#    into ~/.npmrc, back when the package was published to GitHub Packages.
#    That line silently wins over the public registry, so an upgrade would
#    reinstall the old private build — or fail with a 404 once the GitHub
#    Packages version is gone. Nothing else in cccollab needs a scope mapping.
NPMRC="${HOME}/.npmrc"
if [ -f "$NPMRC" ] && grep -q '^@kollaborativeai:registry=https://npm\.pkg\.github\.com' "$NPMRC"; then
  log "Removing the stale @kollaborativeai -> GitHub Packages mapping from ~/.npmrc"
  tmpfile=$(mktemp)
  grep -v '^@kollaborativeai:registry=https://npm\.pkg\.github\.com' "$NPMRC" >"$tmpfile"
  mv "$tmpfile" "$NPMRC"
fi

# 3. Install the package from the public npm registry
log "Installing @kollaborativeai/cccollab..."
npm i -g @kollaborativeai/cccollab

# 4. Verify the binary is actually reachable on PATH.
#
#    Claude Code spawns the MCP server as the bare command `cccollab` (see
#    plugin/.mcp.json). Node version managers - volta, nvm, fnm, asdf - install
#    global binaries into the *active* Node version's prefix, so a later
#    `nvm use` can leave the binary installed but off PATH. When that happens
#    Claude Code reports a dead MCP server rather than anything diagnosable, so
#    fail loudly here instead.
if ! command -v cccollab >/dev/null 2>&1; then
  err "cccollab installed but is not on PATH.

  This usually means a Node version manager (volta, nvm, fnm, asdf) put it in
  a version-specific prefix. Claude Code launches the MCP server as the bare
  command 'cccollab', so it must resolve on PATH in the shell that starts
  Claude Code.

  Check where npm put it:   npm prefix -g
  Then either add that bin/ directory to PATH, or re-run this installer from
  the Node version you launch Claude Code with."
fi
log "cccollab resolves at $(command -v cccollab)"

# 5. Wire it into Claude Code.
#
#    `cccollab init` owns the marketplace registration, the plugin install,
#    retiring the old cccollab@flatoutsolutions plugin, and the shell alias for
#    the launch flag. Keeping that logic in the binary means the Homebrew
#    formula (which must not mutate ~/.claude from post_install) and this
#    script run exactly the same steps.
log "Wiring cccollab into Claude Code..."
cccollab init

cat <<'EOF'

  - Local mode (sessions on one machine) works immediately, no account needed.
  - For cross-machine topics, run the `authenticate` MCP tool inside Claude
    Code to sign in to the hosted backend at collab.kollaborativeai.com.

Upgrading from cccollab@flatoutsolutions? Also update the enabledPlugins keys
in ~/.claude/settings.json to cccollab@kollaborativeai.

EOF
