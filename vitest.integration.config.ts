/// <reference types="vitest" />
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

/**
 * Vitest config for Convex integration tests - slower, tests that exercise
 * end-to-end query/mutation pipelines against `convex-test`. Kept separate
 * from the main suite so unit tests stay fast and CI can gate them
 * differently if needed.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    test: {
      env: { ...env },
      testTimeout: 30_000,
      include: ['convex/**/*.integration.test.ts'],
      environmentMatchGlobs: [['convex/**', 'edge-runtime']],
    },
  }
})
