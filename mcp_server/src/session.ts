import path from 'node:path'
import type { SessionIdentity } from './transport/index.js'

const SESSION_PREFIX_PATTERN = /^\*\[(.+?)\]\*:\s*([\s\S]*)$/

/**
 * Resolve the stable key a restarted server keys its persisted state on
 * (KAI-415). Anchors on the Claude Code session UUID — self-declared at
 * `introduce` rather than derived from the human-typed `name` — so a
 * session that renames itself still resolves to the same key across a
 * restart. Returns `null` when no usable id was declared: callers fall
 * back to no persistence at all (there is no name-keyed disk path), which
 * is the pre-existing floor, not a regression.
 *
 * A blank id counts as "none declared". `?? ` alone would treat `''` as
 * a real key, and `sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? ''`
 * is the ordinary way a blank id arrives — so every blank-id session on
 * the machine would collapse onto the single key `''`, share one
 * persisted state file, and restore each other's state. The `typeof`
 * check also holds the signature honest at the untrusted broker HTTP
 * boundary, where `identity` is not validated before it reaches here.
 *
 * The id must also LOOK like an opaque key (C5). It is self-declared, it
 * arrives unvalidated over the unauthenticated broker as well as through
 * the MCP schema, and KAI-415 turns whatever comes back into a persisted
 * state FILE NAME. A value carrying a path separator, a NUL, or a control
 * character is not an identifier — declining it here protects every
 * consumer at once, including the HTTP boundary that never sees the zod
 * schema. The length bound is the same argument: an in-memory registry
 * has no business round-tripping a 10 000-character "id".
 */
const MAX_SESSION_ID_LENGTH = 200
/**
 * Same allowlist as `session-state.ts` `SAFE_SESSION_ID` (KAI-415 I3).
 * Shared by construction: whatever can become a file name must pass here
 * first so a hostile env id never arms the persistence hook only to throw
 * on every later save. Keep these two regexes in lock-step.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Path-safe session id: alphanumeric start, then alnum / `.` / `_` / `-`. */
export function isSafeSessionId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_SESSION_ID_LENGTH && SAFE_SESSION_ID.test(id)
}

export function sessionKey(identity: SessionIdentity | undefined): string | null {
  const id = identity?.sessionId
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  // I3: refuse anything that cannot be a sessions-dir filename so the
  // writer is never armed for a key load returns null on and save throws on.
  if (!isSafeSessionId(trimmed)) return null
  return trimmed
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
  const raw = env[SESSION_ID_ENV_VAR]?.trim()
  // I3: drop unsafe ids at the env boundary so sessionId never holds a
  // value that sessionKey would reject and save would throw on.
  const sessionId = raw && isSafeSessionId(raw) ? raw : undefined
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
  private organizationId: string | undefined
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

  /** Organization the session introduced with. Remote transports scope the
   *  registration to it; the local broker is single-tenant and ignores it. */
  setOrganizationId(organizationId: string | undefined): void {
    this.organizationId = organizationId
  }

  getOrganizationId(): string | undefined {
    return this.organizationId
  }

  /**
   * The complete `Transport.introduce` payload for this session.
   *
   * Every introduce goes through here. `introduce` is called from three
   * places — the `introduce` tool, `attachLocation`, and server startup —
   * and before KAI-401 each one hand-assembled its own argument object.
   * Two of the three built `{sessionName, objective}` and silently dropped
   * `identity` (and `organizationId`), so any location attached *after*
   * the session declared an identity registered without one, with no
   * surface reporting the loss: nothing was refused, because nothing was
   * sent.
   *
   * Owning the payload here makes forwarding structural: a field added to
   * the session reaches every transport by construction, not by a
   * maintainer remembering the other two call sites.
   */
  introduceArgs(): {
    sessionName: string
    objective?: string
    organizationId?: string
    identity?: SessionIdentity
  } {
    return {
      sessionName: this.displayName,
      objective: this.objective,
      organizationId: this.organizationId,
      identity: this.identity,
    }
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
