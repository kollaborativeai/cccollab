import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROFILE = process.env.CCCOLLAB_PROFILE?.trim() || 'default'
export const CCCOLLAB_HOME = join(homedir(), '.cccollab')
export const CCCOLLAB_RUN_DIR = join(CCCOLLAB_HOME, 'run')
export const CCCOLLAB_LOGS_DIR = join(CCCOLLAB_HOME, 'logs')
export const BROKER_RENDEZVOUS_FILE = join(CCCOLLAB_RUN_DIR, `${PROFILE}.json`)
