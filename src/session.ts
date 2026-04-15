import path from 'node:path'

const SESSION_PREFIX_PATTERN = /^\*\[(.+?)\]\*:\s*([\s\S]*)$/

interface SessionManagerOptions {
  username: string
  cwd: string
  worktreeName?: string
}

export class SessionManager {
  private name: string
  private readonly username: string

  constructor(options: SessionManagerOptions) {
    this.username = options.username
    this.name = this.deriveName(options)
  }

  get sessionName(): string { return this.name }

  overrideName(newName: string): void { this.name = newName }

  fmt(text: string): string { return `*[${this.name}]*: ${text}` }

  isSelf(senderName: string): boolean { return senderName === this.name }

  static parse(text: string): { sender: string; text: string } | null {
    const match = SESSION_PREFIX_PATTERN.exec(text)
    if (!match) return null
    return { sender: match[1], text: match[2] }
  }

  private deriveName(options: SessionManagerOptions): string {
    const dirName = path.basename(options.cwd)
    if (!dirName || dirName === '/') {
      return `${options.username}-unknown`
    }

    let repoName = dirName
    if (options.worktreeName) {
      const suffix = `-${options.worktreeName}`
      if (repoName.endsWith(suffix)) {
        repoName = repoName.slice(0, -suffix.length)
      }
      return `${options.username}-${repoName}-${options.worktreeName}`
    }

    return `${options.username}-${repoName}`
  }
}
