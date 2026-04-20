import convexPlugin from '@convex-dev/eslint-plugin'
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Root-level ESLint config. Scoped to the repo-root Convex backend only.
 * The `mcp_server/` workspace has its own `eslint.config.js` and is not
 * covered here; running `yarn lint` at the root chains both.
 */
export default defineConfig([
  {
    ignores: ['node_modules', 'mcp_server', '.yarn', '.codegraph', 'dist', 'convex/_generated'],
  },
  {
    files: ['convex/**/*.ts', 'eslint.config.ts', 'vitest.config.ts', 'vitest.integration.config.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  ...convexPlugin.configs.recommended,
])
