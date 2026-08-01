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

# 2. Install the package from the public npm registry
log "Installing @kollaborativeai/cccollab..."
npm i -g @kollaborativeai/cccollab

# 3. Verify the binary is actually reachable on PATH.
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

# 4. Retire any pre-rebrand install of cccollab@flatoutsolutions.
#    Only the plugin is removed: the marketplace it came from also serves
#    unrelated plugins, so unregistering it would break them.
if claude plugin list 2>/dev/null | grep -q "cccollab@flatoutsolutions"; then
  log "Removing the old cccollab@flatoutsolutions plugin..."
  claude plugin uninstall cccollab@flatoutsolutions || true
fi

# 5. Register the kollaborativeai marketplace
if ! claude plugin marketplace list 2>/dev/null | grep -q "^  ❯ kollaborativeai$"; then
  log "Adding kollaborativeai marketplace to Claude Code..."
  claude plugin marketplace add kollaborativeai/cccollab
else
  log "kollaborativeai marketplace already registered."
fi

# 6. Install the plugin (registers the MCP server and bundles the usage skill)
log "Installing the cccollab plugin..."
claude plugin install cccollab@kollaborativeai

log "Done."
cat <<'EOF'

One more step - cccollab needs a flag to receive messages:

    claude --dangerously-load-development-channels plugin:cccollab@kollaborativeai

Without it the tools load but no messages ever arrive. Claude Code shows a
confirmation dialog the first time; choose "I am using this for local
development".

The flag is required because Claude Code only delivers pushed messages for
plugins on Anthropic's channel allowlist, and cccollab ships from its own
marketplace. It is not a temporary preview gate.

Alias it once:

    alias ccc='claude --dangerously-load-development-channels plugin:cccollab@kollaborativeai'

Then:

  - Local mode (sessions on one machine) works immediately, no account needed.
  - For cross-machine topics, run the `authenticate` MCP tool inside Claude
    Code to sign in to the hosted backend at collab.kollaborativeai.com.

Upgrading from cccollab@flatoutsolutions? Update any shell alias and the
enabledPlugins keys in ~/.claude/settings.json to cccollab@kollaborativeai.

EOF
