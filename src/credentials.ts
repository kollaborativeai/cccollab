import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CONFIG_DIR = path.join(homedir(), '.config', 'cccollab')

export interface StoredCredentials {
  botToken: string
  userToken: string
  teamId: string
  teamName: string
  userId: string
  userName: string
}

export function getCredentialsPath(): string {
  const profile = process.env.CCCOLLAB_PROFILE?.trim()
  const filename = profile ? `credentials-${profile}.json` : 'credentials.json'
  return path.join(CONFIG_DIR, filename)
}

export function loadCredentials(): StoredCredentials | null {
  try {
    const data = readFileSync(getCredentialsPath(), 'utf-8')
    return JSON.parse(data) as StoredCredentials
  } catch {
    return null
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(getCredentialsPath(), JSON.stringify(creds, null, 2), { mode: 0o600 })
}
