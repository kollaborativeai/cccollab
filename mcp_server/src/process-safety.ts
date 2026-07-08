/**
 * Process-level safety net for the cccollab MCP server.
 *
 * The server is a long-lived stdio daemon whose primary job is to keep
 * the LOCAL broker connection serving. A background error from one
 * transport — most notably a remote `ConvexClient` whose websocket / auth
 * handshake rejects (e.g. a prod "Server Error") — surfaces as an
 * `unhandledRejection`. Node's default for that (since v15) is to
 * terminate the process, which would take the local broker down with it
 * and brick cccollab for EVERY session on the machine (KAI-368).
 *
 * So we install handlers that LOG and keep the process alive. For a
 * stdio daemon this is the correct trade-off: staying up to serve local
 * beats crashing over a single remote's failure. The error is still
 * surfaced (to stderr / the debug log) so it isn't silently lost.
 *
 * `on` is injectable purely so this is unit-testable without registering
 * real listeners that would collide with the test runner's own.
 */
export function installProcessSafetyNet(
  log: (message: string) => void,
  on: (event: string, handler: (...args: unknown[]) => void) => void = (event, handler) => {
    process.on(event as 'unhandledRejection', handler)
  },
): void {
  on('unhandledRejection', (reason) => {
    log(`Unhandled promise rejection (kept alive to protect local + other transports): ${describe(reason)}`)
  })
  on('uncaughtException', (err) => {
    log(`Uncaught exception (kept alive to protect local + other transports): ${describe(err)}`)
  })
}

/** Render an arbitrary thrown/rejected value as a single log-friendly line. */
function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }
  return String(value)
}
