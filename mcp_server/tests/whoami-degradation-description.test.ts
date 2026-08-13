import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * cc#41: the `whoami` tool description is a contract read by an LLM, and it
 * said `degradation` is set ONLY on a transport that has self-disabled.
 *
 * KAI-516 changed that: a partial degradation — an ENABLED transport whose
 * capabilities are reduced, e.g. `channels.listForUser` missing so the own
 * row under-reports its channels — is now surfaced through the same public
 * `degradation` field. A caller told the old rule reads `enabled: true` and
 * treats a partially working location as healthy, which is exactly the
 * silent-blindness class this ticket is closing.
 *
 * Asserted against the source because the description is a literal in the
 * registration call, not reachable without standing up an MCP server.
 */
describe('cc#41: whoami description covers partial degradation', () => {
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf-8')
  const whoamiBlock = src.slice(src.indexOf("registerTool(\n    'whoami'"), src.indexOf('inputSchema: {},'))

  it('does not claim degradation is set only on self-disabled transports', () => {
    expect(whoamiBlock).not.toMatch(/set only on transports that have self-disabled/)
  })

  it('tells the caller an enabled transport can also carry a degradation', () => {
    expect(whoamiBlock).toMatch(/ENABLED/)
    expect(whoamiBlock).toMatch(/reduced/)
  })
})
