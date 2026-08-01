import { describe, it, expect } from 'vitest'
import {
  runInit,
  parseInitArgs,
  rcFileFor,
  rcAlreadyHasFlag,
  hasMarketplace,
  ALIAS_LINE,
  type InitDeps,
  type RunResult,
} from '../src/init.js'

interface Harness {
  deps: InitDeps
  calls: string[][]
  logs: string[]
  appended: Array<{ path: string; text: string }>
}

function harness(overrides: Partial<InitDeps> & { results?: Record<string, RunResult> } = {}): Harness {
  const calls: string[][] = []
  const logs: string[] = []
  const appended: Array<{ path: string; text: string }> = []
  const results = overrides.results ?? {}

  const deps: InitDeps = {
    run(cmd, args) {
      calls.push([cmd, ...args])
      return results[args.join(' ')] ?? { code: 0, stdout: '' }
    },
    which: () => true,
    readFile: () => undefined,
    appendFile: (path, text) => appended.push({ path, text }),
    fileExists: () => true,
    confirm: async () => false,
    log: (m) => logs.push(m),
    homeDir: '/home/dev',
    shell: '/bin/zsh',
    ...overrides,
  }
  return { deps, calls, logs, appended }
}

const ran = (calls: string[][], needle: string) => calls.some((c) => c.join(' ').includes(needle))

describe('parseInitArgs', () => {
  it('defaults to interactive with alias handling on', () => {
    expect(parseInitArgs([])).toEqual({ yes: false, noAlias: false })
  })

  it('accepts --yes and -y', () => {
    expect(parseInitArgs(['--yes']).yes).toBe(true)
    expect(parseInitArgs(['-y']).yes).toBe(true)
  })

  it('accepts --no-alias', () => {
    expect(parseInitArgs(['--no-alias']).noAlias).toBe(true)
  })
})

describe('rcFileFor', () => {
  it('maps zsh and bash to their rc files', () => {
    expect(rcFileFor('/bin/zsh', '/home/dev')).toBe('/home/dev/.zshrc')
    expect(rcFileFor('/usr/local/bin/bash', '/home/dev')).toBe('/home/dev/.bashrc')
  })

  it('returns undefined for shells whose config format we do not know', () => {
    // Guessing at fish/nushell syntax would write a broken line into a file
    // the user did not ask us to touch. Print the alias instead.
    expect(rcFileFor('/usr/bin/fish', '/home/dev')).toBeUndefined()
    expect(rcFileFor('', '/home/dev')).toBeUndefined()
  })
})

describe('hasMarketplace', () => {
  it('matches a whole entry, not a substring', () => {
    expect(hasMarketplace('  ❯ kollaborativeai\n  ❯ other', 'kollaborativeai')).toBe(true)
    expect(hasMarketplace('  ❯ kollaborativeai-staging', 'kollaborativeai')).toBe(false)
  })
})

describe('rcAlreadyHasFlag', () => {
  it('detects an existing launch-flag line regardless of alias name', () => {
    expect(
      rcAlreadyHasFlag(
        "alias whatever='claude --dangerously-load-development-channels plugin:cccollab@kollaborativeai'",
      ),
    ).toBe(true)
    expect(rcAlreadyHasFlag('alias ccc=something-else')).toBe(false)
    expect(rcAlreadyHasFlag(undefined)).toBe(false)
  })
})

describe('runInit', () => {
  it('fails clearly when the claude CLI is missing, before changing anything', async () => {
    const h = harness({ which: () => false })
    const code = await runInit({ yes: true, noAlias: false }, h.deps)
    expect(code).toBe(1)
    expect(h.logs.join('\n')).toContain('not on PATH')
    expect(h.calls).toEqual([])
    expect(h.appended).toEqual([])
  })

  it('registers the marketplace and installs the plugin on a clean machine', async () => {
    const h = harness()
    expect(await runInit({ yes: true, noAlias: true }, h.deps)).toBe(0)
    expect(ran(h.calls, 'marketplace add kollaborativeai/cccollab')).toBe(true)
    expect(ran(h.calls, 'plugin install cccollab@kollaborativeai')).toBe(true)
  })

  it('is idempotent: skips both steps when already configured', async () => {
    const h = harness({
      results: {
        'plugin list': { code: 0, stdout: 'cccollab@kollaborativeai' },
        'plugin marketplace list': { code: 0, stdout: '  ❯ kollaborativeai' },
      },
    })
    expect(await runInit({ yes: true, noAlias: true }, h.deps)).toBe(0)
    expect(ran(h.calls, 'marketplace add')).toBe(false)
    expect(ran(h.calls, 'plugin install')).toBe(false)
    expect(h.logs.join('\n')).toContain('already registered')
  })

  it('uninstalls the retired plugin but never unregisters its marketplace', async () => {
    // That marketplace also serves unrelated plugins; removing it would break them.
    const h = harness({
      results: { 'plugin list': { code: 0, stdout: 'cccollab@flatoutsolutions' } },
    })
    await runInit({ yes: true, noAlias: true }, h.deps)
    expect(ran(h.calls, 'plugin uninstall cccollab@flatoutsolutions')).toBe(true)
    expect(ran(h.calls, 'marketplace remove')).toBe(false)
  })

  it('reports failure when the marketplace cannot be added', async () => {
    const h = harness({
      results: { 'plugin marketplace add kollaborativeai/cccollab': { code: 1, stdout: 'boom' } },
    })
    expect(await runInit({ yes: true, noAlias: true }, h.deps)).toBe(1)
    expect(ran(h.calls, 'plugin install')).toBe(false)
  })

  it('writes the alias with --yes', async () => {
    const h = harness()
    await runInit({ yes: true, noAlias: false }, h.deps)
    expect(h.appended).toHaveLength(1)
    expect(h.appended[0]!.path).toBe('/home/dev/.zshrc')
    expect(h.appended[0]!.text).toContain(ALIAS_LINE)
  })

  it('leaves the rc file untouched when the user declines', async () => {
    const h = harness({ confirm: async () => false })
    await runInit({ yes: false, noAlias: false }, h.deps)
    expect(h.appended).toEqual([])
    expect(h.logs.join('\n')).toContain('untouched')
  })

  it('never prompts or writes with --no-alias', async () => {
    let asked = false
    const h = harness({
      confirm: async () => {
        asked = true
        return true
      },
    })
    await runInit({ yes: false, noAlias: true }, h.deps)
    expect(asked).toBe(false)
    expect(h.appended).toEqual([])
  })

  it('does not add a second alias when one is already present', async () => {
    const h = harness({ readFile: () => ALIAS_LINE })
    await runInit({ yes: true, noAlias: false }, h.deps)
    expect(h.appended).toEqual([])
    expect(h.logs.join('\n')).toContain('already in')
  })

  it('prints the alias instead of guessing at an unknown shell config format', async () => {
    const h = harness({ shell: '/usr/bin/fish' })
    await runInit({ yes: true, noAlias: false }, h.deps)
    expect(h.appended).toEqual([])
    expect(h.logs.join('\n')).toContain(ALIAS_LINE)
  })

  it('always surfaces the launch flag, since nothing arrives without it', async () => {
    const h = harness()
    await runInit({ yes: true, noAlias: true }, h.deps)
    expect(h.logs.join('\n')).toContain('--dangerously-load-development-channels')
  })
})
