/**
 * Process-level safety net for the cccollab MCP server.
 *
 * The server is a long-lived stdio daemon. The failure this guards against
 * (KAI-368) is a remote transport's `ConvexClient` whose websocket / auth
 * handshake rejects in the BACKGROUND (e.g. a prod "Server Error"), which
 * surfaces as an `unhandledRejection`. Node's default since v15 is to
 * terminate the process on that — which kills THIS session's in-process
 * local transport and its tools (the detached broker process itself
 * survives, but this session loses its connection to it). Because every
 * session loads the same config, each one crashes the same way, so a
 * single bad remote credential takes out local collaboration for all of
 * them.
 *
 * The two handlers are deliberately NOT symmetric:
 *
 *  - `unhandledRejection` — LOG and keep running. This is the actual
 *    KAI-368 fix: a background transport rejection must not take the
 *    session down. Any registered listener overrides Node's terminate-by-
 *    default behaviour.
 *
 *  - `uncaughtException` — LOG then EXIT(1). Node's contract is that the
 *    process may be in an undefined state after an uncaught exception, so
 *    resuming risks corrupt state persisting across later tool calls and
 *    real bugs being masked. We fail fast with a clean exit (and do NO
 *    async work in the handler, which Node discourages); the MCP client
 *    can start a fresh server.
 */

/** The minimal slice of `process` this needs. Declared as an interface so
 *  tests can inject a fake and exercise real handler registration without
 *  colliding with the test runner's own process listeners — and so the
 *  default can be `process` with no type-cast. */
export interface ProcessSafetyTarget {
  on(event: 'unhandledRejection' | 'uncaughtException', handler: (...args: unknown[]) => void): unknown
  exit(code: number): unknown
}

/** Targets already wired, so a repeat call can't stack duplicate listeners
 *  (which would eventually trip Node's `MaxListenersExceeded` warning).
 *  A WeakSet keyed on the target means the guard works for both the real
 *  `process` and any injected test target without leaking state. */
const installedTargets = new WeakSet<ProcessSafetyTarget>()

export function installProcessSafetyNet(log: (message: string) => void, target: ProcessSafetyTarget = process): void {
  if (installedTargets.has(target)) return
  installedTargets.add(target)

  target.on('unhandledRejection', (reason) => {
    log(`Unhandled promise rejection (kept alive to keep local + other transports serving): ${describe(reason)}`)
  })

  target.on('uncaughtException', (err) => {
    log(
      `Uncaught exception (exiting so a clean server can start; resuming could persist corrupt state): ${describe(err)}`,
    )
    target.exit(1)
  })
}

/** Render an arbitrary thrown/rejected value as a single log-friendly line. */
function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }
  return String(value)
}
