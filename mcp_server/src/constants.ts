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

/**
 * Defaults for the hosted KAI-backed remote location. These are
 * non-secret pointers (a public proxy URL and a public Clerk OAuth app
 * pointer) that let a brand-new install talk to the production cccollab
 * backend with an empty ~/.cccollab/config.json. Self-hosters override
 * any field by declaring it under `locations.<name>` in their config.
 *
 * Wired in src/config/defaults.ts. Injected after merge, before env
 * overrides, so CCCOLLAB_REMOTE_URL still wins as expected.
 */
export const DEFAULT_REMOTE_LOCATION_NAME = 'kai'
export const DEFAULT_REMOTE_URL = 'https://collab.kollaborativeai.com'
// TODO before deploy: replace placeholder with the production Clerk
// instance URL. Until then, the value below is a syntactically valid but
// non-resolving placeholder so the load-time guard below passes during
// CI; OAuth will still fail at runtime (browser DNS) until this is set.
export const DEFAULT_CLERK_ISSUER = 'https://kai-prod-placeholder.clerk.accounts.dev'
export const DEFAULT_CLERK_CLIENT_ID = 'cccollab-cli'

// Guard against shipping the unfilled placeholder. The `<...>` substring
// is a marker the deployer must replace before publishing to npm — fail
// at module load with a clear message rather than producing a Clerk URL
// that 404s the user's browser later.
if (DEFAULT_CLERK_ISSUER.includes('<')) {
  throw new Error(
    'DEFAULT_CLERK_ISSUER still contains the <kai-prod-instance> placeholder. ' +
      'Replace it in src/constants.ts before publishing the package.',
  )
}
