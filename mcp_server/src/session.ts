import path from 'node:path'
import type { SessionIdentity } from './transport/index.js'

const SESSION_PREFIX_PATTERN = /^\*\[(.+?)\]\*:\s*([\s\S]*)$/

/**
 * Resolve the stable key a restarted server keys its persisted state on
 * (KAI-415). Anchors on the Claude Code session UUID — assigned by Claude
 * Code, not the human-typed `name` — so a session that renames itself
 * still resolves to the same key across a restart. Returns `null` when no
 * UUID was declared: callers fall back to today's name-keyed behavior
 * (no persistence), which is the pre-existing floor, not a regression.
 */
export function sessionKey(identity: SessionIdentity | undefined): string | null {
  return identity?.sessionId ?? null
}

/**
 * Env var Claude Code exports into every MCP server it spawns, carrying
 * the UUID of the owning Claude Code session. This is what makes KAI-415
 * persistence zero-configuration: the session does not have to declare
 * anything at introduce for its state to survive a restart.
 */
const SESSION_ID_ENV_VAR = 'CLAUDE_CODE_SESSION_ID'

/**
 * Derive the baseline identity from the process environment at startup.
 *
 * Only fields we genuinely have are set. In particular an unset — or
 * blank — `CLAUDE_CODE_SESSION_ID` must yield NO `sessionId` rather than
 * an empty string: `sessionKey` maps absent-sessionId to `null`, which
 * is what disables persistence entirely. An empty string would instead
 * key every un-identified session on this machine to the SAME state file
 * and cross-contaminate them.
 */
export function identityFromEnv(env: NodeJS.ProcessEnv, cwd: string, pid: number): SessionIdentity | undefined {
  const sessionId = env[SESSION_ID_ENV_VAR]?.trim()
  return compactIdentity({
    ...(sessionId ? { sessionId } : {}),
    cwd,
    pid,
  })
}

/**
 * Overlay a self-declared identity (KAI-401's `introduce({identity})`)
 * onto the env-derived base.
 *
 * Declared fields win — that is KAI-401's contract, and a session that
 * knows its own repo/worktree/branch knows better than we do. But a
 * declaration is a PARTIAL statement, not a replacement: fields it never
 * mentions fall back to the base. Without that, an
 * `introduce({identity: {repo: 'x'}})` would erase the env-derived
 * `sessionId` and silently switch persistence off for the rest of the
 * session — the exact failure KAI-415 exists to prevent.
 *
 * Returns `undefined` when the result carries nothing, so a session that
 * declares nothing and has no env UUID puts no `identity` key on the
 * wire at all (preserving KAI-401's no-breaking-change guarantee).
 */
export function mergeIdentity(
  base: SessionIdentity | undefined,
  declared: SessionIdentity | undefined,
): SessionIdentity | undefined {
  return compactIdentity({ ...base, ...compactIdentity(declared ?? {}) })
}

/** Drop keys whose value is undefined, and collapse a fully-empty
 *  identity to `undefined`. Spreading a partial over a base would
 *  otherwise let an explicit `{sessionId: undefined}` erase a real base
 *  value, since spread copies present-but-undefined keys. */
function compactIdentity(identity: SessionIdentity): SessionIdentity | undefined {
  const entries = Object.entries(identity).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? (Object.fromEntries(entries) as SessionIdentity) : undefined
}

interface SessionManagerOptions {
  username: string
  cwd: string
  worktreeName?: string
}

export class SessionManager {
  private readonly username: string
  private projectName: string
  private name: string | undefined
  private objective: string | undefined
  private identity: SessionIdentity | undefined

  constructor(options: SessionManagerOptions) {
    this.username = options.username
    this.projectName = this.deriveProjectName(options)
  }

  /** Full identity for registry: "stefan | dispatcher | architect" */
  get sessionName(): string {
    const parts = [this.username, this.projectName]
    if (this.name) parts.push(this.name)
    return parts.join(' | ')
  }

  /** Short name for thread messages: the chosen name, or username if not set */
  get displayName(): string {
    return this.name ?? this.username
  }

  setName(name: string): void {
    this.name = name
  }

  setObjective(objective: string | undefined): void {
    this.objective = objective
  }

  getObjective(): string | undefined {
    return this.objective
  }

  /** Self-declared identity (KAI-401), or undefined when none was declared. */
  setIdentity(identity: SessionIdentity | undefined): void {
    this.identity = identity
  }

  getIdentity(): SessionIdentity | undefined {
    return this.identity
  }

  /** Format a thread message with short display name */
  fmt(text: string): string {
    return `*[${this.displayName}]*: ${text}`
  }

  /** Check if a sender matches this session (checks both full and short name) */
  isSelf(senderName: string): boolean {
    return senderName === this.sessionName || senderName === this.displayName
  }

  /** Strict check - only matches the explicitly set name, not the username fallback */
  isExactSelf(senderName: string): boolean {
    return this.name !== undefined && senderName === this.name
  }

  /** True once introduce() has been called */
  hasName(): boolean {
    return this.name !== undefined
  }

  static parse(text: string): { sender: string; text: string } | null {
    const match = SESSION_PREFIX_PATTERN.exec(text)
    if (!match) return null
    return { sender: match[1]!, text: match[2]! }
  }

  private deriveProjectName(options: SessionManagerOptions): string {
    const dirName = path.basename(options.cwd)
    if (!dirName || dirName === '/') {
      return 'unknown'
    }

    let repoName = dirName
    if (options.worktreeName) {
      const suffix = `-${options.worktreeName}`
      if (repoName.endsWith(suffix)) {
        repoName = repoName.slice(0, -suffix.length)
      }
      return `${repoName}-${options.worktreeName}`
    }

    return repoName
  }
}
