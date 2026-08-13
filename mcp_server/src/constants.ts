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
 *
 * `DEFAULT_REMOTE_URL` is the branded Cloudflare Worker that reverse-
 * proxies KAI's Convex deployment. The raw `*.convex.cloud` URL is
 * deliberately NOT baked here (KAI-316): it lives only in the worker's
 * upstream config, so the client never carries it.
 */
/**
 * How long a registration's last liveness signal may be before
 * `list_sessions` treats it as dead and drops it (KAI-515).
 *
 * Shared rather than duplicated because two layers must agree on it: the
 * tool layer applies it to decide what to show, and the transport layer
 * measures its own heartbeat against it to know when a stalled heartbeat
 * has stopped being a blip and started making this session invisible to
 * its peers. Change it here and both follow.
 */
export const SESSION_STALE_MS = 5 * 60_000

export const DEFAULT_REMOTE_LOCATION_NAME = 'remote'
export const DEFAULT_REMOTE_URL = 'https://collab.kollaborativeai.com'
export const DEFAULT_CLERK_ISSUER = 'https://clerk.kollaborativeai.com'
export const DEFAULT_CLERK_CLIENT_ID = 'fPDyXbk1afJeEE2S'
