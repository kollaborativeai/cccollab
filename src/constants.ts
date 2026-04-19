import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveInitialProfile } from './initial-profile.js'

export const PROFILE = resolveInitialProfile()
export const CCCOLLAB_HOME = join(homedir(), '.cccollab')
export const CCCOLLAB_RUN_DIR = join(CCCOLLAB_HOME, 'run')
export const CCCOLLAB_LOGS_DIR = join(CCCOLLAB_HOME, 'logs')
export const BROKER_RENDEZVOUS_FILE = join(CCCOLLAB_RUN_DIR, `${PROFILE}.json`)
