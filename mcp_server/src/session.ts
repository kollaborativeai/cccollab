import path from 'node:path'
import type { SessionIdentity } from './transport/index.js'

const SESSION_PREFIX_PATTERN = /^\*\[(.+?)\]\*:\s*([\s\S]*)$/

/**
 * Resolve the stable key a restarted server keys its persisted state on
 * (KAI-415). Anchors on the Claude Code session UUID — self-declared at
 * `introduce` rather than derived from the human-typed `name` — so a
 * session that renames itself still resolves to the same key across a
 * restart. Returns `null` when no usable id was declared: callers fall
 * back to today's name-keyed behavior (no persistence), which is the
 * pre-existing floor, not a regression.
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
// eslint-disable-next-line no-control-regex -- control chars are exactly what this rejects
const UNSAFE_SESSION_ID = /[/\\]|[\u0000-\u001f\u007f]/

export function sessionKey(identity: SessionIdentity | undefined): string | null {
  const id = identity?.sessionId
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return null
  if (trimmed.length > MAX_SESSION_ID_LENGTH) return null
  if (UNSAFE_SESSION_ID.test(trimmed)) return null
  // `trimmed`, not `id`: every guard above runs against the trimmed value, so
  // returning the raw one validated one string and handed back another.
  // `String.prototype.trim` strips tab, newline, CR, VT and FF — every one of
  // them inside the U+0000..U+001F range UNSAFE_SESSION_ID exists to reject —
  // and it strips the padding the length bound was measured without. So an id
  // with an edge control character, or 202 characters of which 200 are real,
  // was checked away and then returned to a caller typed to trust it (cc#37).
  return trimmed
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
