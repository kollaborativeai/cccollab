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

/**
 * Parse a positive-integer tuning knob. `undefined` means "not a value this
 * codebase accepts" — non-numeric, non-finite, or below 1 — and each caller
 * decides what to do about that: `broker.ts` refuses to boot, the listener
 * falls back to the default it would have used anyway.
 *
 * Lives here, and not in either caller, because the broker and the listener
 * must agree on what a given `CCCOLLAB_HEARTBEAT_MS` MEANS. Two copies of this
 * rule is how the pair below drifts apart again.
 */
export function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.floor(n)
}

/** Interval between the broker's SSE comment frames when nothing is set. */
export const DEFAULT_BROKER_HEARTBEAT_MS = 15_000

/**
 * The heartbeat interval the broker will use — the single reader of
 * `CCCOLLAB_HEARTBEAT_MS`, so the listener can size its read deadline against
 * the SAME number the broker beats on (see `readDeadlineMsFor`).
 *
 * Read at call time rather than frozen at import: the broker is a spawned child
 * process, so the environment is the only injection channel its own tests have,
 * and a module-level constant would capture whatever was set when the first
 * importer loaded.
 *
 * A value the broker would refuse resolves to the default here rather than
 * throwing. That is not leniency: on such a value the broker exits at boot, so
 * there is no heartbeat to be sized against and no healthy stream to protect —
 * making the whole MCP server fail to import over a broker knob would turn one
 * dead child process into a dead session.
 */
export function brokerHeartbeatMs(): number {
  return parsePositiveInt(process.env.CCCOLLAB_HEARTBEAT_MS) ?? DEFAULT_BROKER_HEARTBEAT_MS
}

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
export const DEFAULT_REMOTE_LOCATION_NAME = 'remote'
export const DEFAULT_REMOTE_URL = 'https://collab.kollaborativeai.com'
export const DEFAULT_CLERK_ISSUER = 'https://clerk.kollaborativeai.com'
export const DEFAULT_CLERK_CLIENT_ID = 'fPDyXbk1afJeEE2S'
