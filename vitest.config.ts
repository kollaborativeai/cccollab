/// <reference types="vitest" />
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Root vitest config. Runs Convex backend tests using the edge-runtime
 * environment, which is what `convex-test` expects for realistic fidelity.
 *
 * The `mcp_server/` workspace has its own vitest config and runs in
 * standard Node; that suite is orchestrated via `yarn workspaces foreach`.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    test: {
      env,
      globals: true,
      include: ['convex/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
      environmentMatchGlobs: [['convex/**', 'edge-runtime']],
    },
  }
})
