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
  private role: string | undefined

  constructor(options: SessionManagerOptions) {
    this.username = options.username
    this.projectName = this.deriveProjectName(options)
  }

  /** Full identity for registry: "stefan | dispatcher | architect" */
  get sessionName(): string {
    const parts = [this.username, this.projectName]
    if (this.role) parts.push(this.role)
    return parts.join(' | ')
  }

  /** Short name for thread messages: just the role, or username if no role set */
  get displayName(): string {
    return this.role ?? this.username
  }

  setRole(role: string): void {
    this.role = role
  }

  overrideName(newName: string): void {
    this.projectName = newName
  }

  /** Format a thread message with short display name */
  fmt(text: string): string {
    return `*[${this.displayName}]*: ${text}`
  }

  /** Check if a sender matches this session (checks both full and short name) */
  isSelf(senderName: string): boolean {
    return senderName === this.sessionName || senderName === this.displayName
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
