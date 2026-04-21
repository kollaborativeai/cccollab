# CCC-22 Scenario Tests

These tests verify the acceptance criteria of [CCC-22](https://flatoutsolutions.atlassian.net/browse/CCC-22) end-to-end:

| AC                                                        | Scenario           | File                                                            |
| --------------------------------------------------------- | ------------------ | --------------------------------------------------------------- |
| OAuth URL reachable                                       | —                  | covered by endpoint integration in `convex/tests/oauth.test.ts` |
| OAuth flow works                                          | `oauth-flow`       | `oauth-flow.scenario.test.ts`                                   |
| Three MCP tools                                           | `mcp-tools`        | `mcp-tools.scenario.test.ts`                                    |
| External message reaches Claude Code session in real time | `cross-visibility` | `cross-visibility.scenario.test.ts`                             |
| Claude Code message visible via `read_topic`              | `cross-visibility` | `cross-visibility.scenario.test.ts`                             |
| External messages attributed to the user                  | `attribution`      | `attribution.scenario.test.ts`                                  |
| Per-user scoping                                          | `scoping`          | `scoping.scenario.test.ts`                                      |

Scenario tests run in the Vitest `edge-runtime` environment (same as convex tests) and use `convex-test` to simulate the Convex backend.
