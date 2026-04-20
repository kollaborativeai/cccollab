import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveInitialProfile } from './initial-profile.js'

export const PROFILE = resolveInitialProfile()
export const CCCOLLAB_HOME = join(homedir(), '.cccollab')
export const CCCOLLAB_RUN_DIR = join(CCCOLLAB_HOME, 'run')
export const CCCOLLAB_LOGS_DIR = join(CCCOLLAB_HOME, 'logs')
export const BROKER_RENDEZVOUS_FILE = join(CCCOLLAB_RUN_DIR, `${PROFILE}.json`)

/**
 * Persistent config for hosted mode. Contains the hosted URL and the
 * OAuth tokens. Chmod 600 on write - tokens must not be world-readable.
 */
export const CCCOLLAB_CONFIG_FILE = join(CCCOLLAB_HOME, 'config.json')
