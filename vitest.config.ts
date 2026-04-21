import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts', 'convex/tests/**/*.test.ts'],
    environmentMatchGlobs: [
      ['convex/tests/**', 'edge-runtime'],
      ['tests/scenarios/**', 'edge-runtime'],
    ],
    server: { deps: { inline: ['convex-test'] } },
  },
})
