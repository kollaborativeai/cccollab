import { LocalTransport } from '../../src/transport/local.js'

/**
 * A `LocalTransport` that has already completed `introduce`, so it holds a
 * broker registration id and its session-scoped calls work.
 *
 * Every session-scoped call is addressed by registration id (KAI-514), and
 * the tool layer gates those calls behind `introduce`; a transport built by
 * hand in a unit test has to mirror that. The registration round-trip is
 * served by a one-shot fetch stub installed and removed here, so it can't
 * interfere with whatever fetch mocking the test does afterwards.
 */
export async function registeredLocalTransport(
  port = 7850,
  id = 'test-registration-id',
  sessionName = 'test',
): Promise<LocalTransport> {
  const transport = new LocalTransport(port)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ ok: true, id }) })) as unknown as typeof fetch
  try {
    await transport.introduce({ sessionName })
  } finally {
    globalThis.fetch = realFetch
  }
  return transport
}
