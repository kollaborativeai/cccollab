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
  private readonly organizations = new Map<string, string>()

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

  /** The organization each LOCATION is currently bound to.
   *
   *  Per-location, not per-session: the backend keys CLI sessions by
   *  (user, org, sessionName), and a location's row only actually rebinds to a
   *  new org once ITS introduce succeeds. If introduce succeeds at one location
   *  and fails at another, recording the org globally would leave the failed
   *  one still on the OLD org on its backend while we believe it moved — so the
   *  next re-introduce would see "no change" there, skip its migration, and
   *  strand a ghost.
   *
   *  The setter takes a DEFINED string, so an org-less introduce structurally
   *  cannot clobber a tracked binding (callers only record on success, with a
   *  defined org). Nothing ever clears a binding. */
  setOrganizationFor(location: string, organization: string): void {
    this.organizations.set(location, organization)
  }

  getOrganizationFor(location: string): string | undefined {
    return this.organizations.get(location)
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
