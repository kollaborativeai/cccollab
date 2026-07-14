import path from 'node:path'

const SESSION_PREFIX_PATTERN = /^\*\[(.+?)\]\*:\s*([\s\S]*)$/

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
  private organization: string | undefined

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

  /** The organization this session most recently introduced into. The
   *  backend keys CLI sessions by (user, org, sessionName), so this is
   *  tracked to detect an org change on a same-name re-introduce, which
   *  would rebind the backend row and orphan the old memberships.
   *
   *  An `undefined` org NEVER clobbers a tracked one. Unlike `objective`,
   *  this binding is monotonic for the session's lifetime: an org-less
   *  re-introduce (reachable once every remote has self-disabled, since the
   *  `hasRemote` gate then stops requiring an `organization`) must not ERASE
   *  the tracked org — doing so would disarm the org-change rejection for the
   *  rest of the session. There is no case where clearing it is meaningful. */
  setOrganization(organization: string | undefined): void {
    if (organization === undefined) return
    this.organization = organization
  }

  getOrganization(): string | undefined {
    return this.organization
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
