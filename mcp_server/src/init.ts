/**
 * `cccollab init` — wire an installed cccollab binary into Claude Code.
 *
 * A working install is four things, not one: the binary on PATH, a Claude Code
 * marketplace registration, a plugin install, and the launch flag that turns on
 * push delivery. A package manager can only deliver the first. Homebrew must
 * not mutate ~/.claude from post_install, so the other three live here.
 *
 * Every step is idempotent: re-running on a configured machine reports what is
 * already correct rather than erroring.
 */

const MARKETPLACE = 'kollaborativeai'
const MARKETPLACE_SOURCE = 'kollaborativeai/cccollab'
const PLUGIN = `cccollab@${MARKETPLACE}`
const RETIRED_PLUGIN = 'cccollab@flatoutsolutions'
export const LAUNCH_FLAG = `claude --dangerously-load-development-channels plugin:${PLUGIN}`
export const ALIAS_LINE = `alias ccc='${LAUNCH_FLAG}'`

export interface RunResult {
  code: number
  stdout: string
}

export interface InitDeps {
  /** Run a command, capturing stdout. Never throws; a non-zero code is data. */
  run(cmd: string, args: string[]): RunResult
  /** True when `cmd` resolves on PATH. */
  which(cmd: string): boolean
  readFile(path: string): string | undefined
  appendFile(path: string, text: string): void
  fileExists(path: string): boolean
  /** Ask the user a yes/no question. Resolves true for yes. */
  confirm(question: string): Promise<boolean>
  log(message: string): void
  homeDir: string
  /** The user's login shell, e.g. `/bin/zsh`. */
  shell: string
}

export interface InitOptions {
  /** Assume yes for every prompt; never blocks. For CI and scripted installs. */
  yes: boolean
  /** Skip shell-alias handling entirely. */
  noAlias: boolean
}

export function parseInitArgs(argv: string[]): InitOptions {
  return {
    yes: argv.includes('--yes') || argv.includes('-y'),
    noAlias: argv.includes('--no-alias'),
  }
}

/**
 * The rc file we would append an alias to, derived from the login shell.
 * Returns undefined for shells we do not know how to edit safely — better to
 * print the alias and let the user place it than to guess at a config format.
 */
export function rcFileFor(shell: string, homeDir: string): string | undefined {
  if (shell.endsWith('/zsh') || shell === 'zsh') return `${homeDir}/.zshrc`
  if (shell.endsWith('/bash') || shell === 'bash') return `${homeDir}/.bashrc`
  return undefined
}

/** True when the rc file already wires up the launch flag in some form. */
export function rcAlreadyHasFlag(contents: string | undefined): boolean {
  if (!contents) return false
  return contents.includes(`plugin:${PLUGIN}`)
}

export async function runInit(options: InitOptions, deps: InitDeps): Promise<number> {
  if (!deps.which('claude')) {
    deps.log(
      'error: the `claude` CLI is not on PATH.\n' +
        '\n' +
        '  cccollab init registers a marketplace and installs a plugin, both of\n' +
        '  which are Claude Code operations. Install Claude Code first:\n' +
        '  https://claude.com/claude-code',
    )
    return 1
  }

  // 1. Retire the pre-rebrand plugin. Only the plugin: the marketplace it came
  //    from also serves unrelated plugins, so unregistering it would break them.
  const installed = deps.run('claude', ['plugin', 'list'])
  if (installed.stdout.includes(RETIRED_PLUGIN)) {
    deps.log(`Removing the retired ${RETIRED_PLUGIN} plugin...`)
    deps.run('claude', ['plugin', 'uninstall', RETIRED_PLUGIN])
  }

  // 2. Register the marketplace.
  const marketplaces = deps.run('claude', ['plugin', 'marketplace', 'list'])
  if (hasMarketplace(marketplaces.stdout, MARKETPLACE)) {
    deps.log(`Marketplace "${MARKETPLACE}" already registered.`)
    // Refresh the local clone before step 3 looks for updates. `plugin update`
    // resolves against this clone, so without a refresh it compares against a
    // stale catalogue and reports "up to date" while a newer version exists.
    deps.run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE])
  } else {
    deps.log(`Registering the "${MARKETPLACE}" marketplace...`)
    const added = deps.run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE])
    if (added.code !== 0) {
      deps.log(`error: could not add the marketplace ${MARKETPLACE_SOURCE}.\n${added.stdout}`)
      return 1
    }
  }

  // 3. Install the plugin, or bring an existing install up to date.
  //    "Already installed" is not the same as "current": Claude Code keeps
  //    every previously installed version cached and loads the one recorded as
  //    installed, so an init that stops at "present" leaves a session reading a
  //    skill several versions behind this binary, silently (KAI-571).
  if (installed.stdout.includes(PLUGIN)) {
    deps.log(`Plugin ${PLUGIN} already installed; checking for updates...`)
    const updated = deps.run('claude', ['plugin', 'update', PLUGIN])
    if (updated.code !== 0) {
      // Not fatal. A reachable-but-stale plugin still works; the rest of init
      // (alias, launch instructions) is still worth completing.
      deps.log(`warning: could not update ${PLUGIN}. Run \`cccollab doctor\` to check for version drift.`)
    }
  } else {
    deps.log(`Installing ${PLUGIN}...`)
    const result = deps.run('claude', ['plugin', 'install', PLUGIN])
    if (result.code !== 0) {
      deps.log(`error: could not install ${PLUGIN}.\n${result.stdout}`)
      return 1
    }
  }

  // 4. The launch flag. Nothing arrives without it, so this is not optional
  //    advice — it is the difference between a working install and one that
  //    looks broken with no error.
  if (!options.noAlias) {
    await handleAlias(options, deps)
  }

  deps.log(
    '\nTo check which plugin versions are on this machine, and remove the ones\n' +
      'nothing is using:\n' +
      '\n    cccollab doctor\n',
  )

  deps.log(
    '\nDone. Start Claude Code with:\n' +
      `\n    ${LAUNCH_FLAG}\n` +
      '\nWithout that flag the tools load but no messages ever arrive. It is not a\n' +
      "temporary preview gate: Claude Code only pushes to plugins on Anthropic's\n" +
      'channel allowlist, and cccollab ships from its own marketplace.',
  )
  return 0
}

async function handleAlias(options: InitOptions, deps: InitDeps): Promise<void> {
  const rc = rcFileFor(deps.shell, deps.homeDir)
  if (!rc) {
    deps.log(`\nAdd this to your shell config to avoid typing the flag every time:\n\n    ${ALIAS_LINE}`)
    return
  }

  const contents = deps.fileExists(rc) ? deps.readFile(rc) : undefined
  if (rcAlreadyHasFlag(contents)) {
    deps.log(`An alias for the launch flag is already in ${rc}.`)
    return
  }

  const wanted = options.yes || (await deps.confirm(`Add a \`ccc\` alias for the launch flag to ${rc}? [y/N] `))
  if (!wanted) {
    deps.log(`\nLeaving ${rc} untouched. To do it yourself:\n\n    ${ALIAS_LINE}`)
    return
  }

  deps.appendFile(rc, `\n# cccollab: launch Claude Code with the channel plugin attached\n${ALIAS_LINE}\n`)
  deps.log(`Added a \`ccc\` alias to ${rc}. Open a new shell, or run: source ${rc}`)
}

/**
 * `claude plugin marketplace list` renders entries as `  ❯ name`. Match the
 * name on its own line so `kollaborativeai` cannot be satisfied by a
 * marketplace merely containing that substring.
 */
export function hasMarketplace(stdout: string, name: string): boolean {
  return stdout.split('\n').some((line) => line.trim().replace(/^❯\s*/, '') === name)
}
