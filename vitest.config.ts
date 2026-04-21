import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/scenarios/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'convex',
          include: ['convex/tests/**/*.test.ts', 'tests/scenarios/**/*.test.ts'],
          environment: 'edge-runtime',
          server: { deps: { inline: ['convex-test'] } },
        },
      },
    ],
  },
})
