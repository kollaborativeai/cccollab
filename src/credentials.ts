import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CONFIG_DIR = path.join(homedir(), '.config', 'claudecode-slack-collab')
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json')

export interface StoredCredentials {
  botToken: string
  userToken: string
  teamId: string
  teamName: string
  userId: string
  userName: string
}

export function loadCredentials(): StoredCredentials | null {
  try {
    const data = readFileSync(CREDENTIALS_FILE, 'utf-8')
    return JSON.parse(data) as StoredCredentials
  } catch {
    return null
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2))
}

export function getCredentialsPath(): string {
  return CREDENTIALS_FILE
}
