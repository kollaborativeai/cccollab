import { homedir } from 'node:os'
import { join } from 'node:path'

export const CCCOLLAB_HOME = join(homedir(), '.cccollab')
export const CCCOLLAB_RUN_DIR = join(CCCOLLAB_HOME, 'run')
export const CCCOLLAB_LOGS_DIR = join(CCCOLLAB_HOME, 'logs')

/**
 * Broker-side file-naming prefix. The unified config has no
 * user-facing profile concept anymore (one broker per user by default),
 * but `broker.ts` and the test harness still consume this token to
 * isolate per-test-run brokers from the machine's default broker. The
 * env var `CCCOLLAB_PROFILE` overrides it for exactly that test-harness
 * use case; production code paths always resolve to `"default"`.
 */
export const PROFILE = process.env.CCCOLLAB_PROFILE?.trim() || 'default'

/** Singleton rendezvous file for the local broker. There's one broker
 *  per user; no per-profile split. */
export const BROKER_RENDEZVOUS_FILE = join(CCCOLLAB_RUN_DIR, `${PROFILE}.json`)

/** Persistent unified config file. Contains the locations map with
 *  credentials, auto-join settings, etc. Chmod 600 on write - tokens
 *  must not be world-readable. See `src/config/`. */
export const CCCOLLAB_CONFIG_FILE = join(CCCOLLAB_HOME, 'config.json')
