import convexPlugin from '@convex-dev/eslint-plugin'
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import tseslint from 'typescript-eslint'

// Root-level ESLint config. Scoped to the repo-root Convex backend only.
// The mcp_server/ workspace has its own eslint.config.js and is not
// covered here; running `yarn lint` at the root chains both.
//
// Scoping note: tseslint.configs.recommended and
// convexPlugin.configs.recommended are arrays of config objects; some
// entries don't have a `files` filter and would apply repo-wide. When
// lint-staged invokes `eslint --fix` from the repo root with a mix of
// paths (convex plus mcp_server), the file-less configs leak onto the
// workspace and typescript-eslint's parser then sees two candidate
// tsconfigs and errors out. Pinning every entry to the convex scope
// plus setting parserOptions.tsconfigRootDir to this directory removes
// the ambiguity.
const SCOPE: string[] = ['convex/**/*.ts', 'eslint.config.ts', 'vitest.config.ts', 'vitest.integration.config.ts']
const TSCONFIG_ROOT_DIR = dirname(fileURLToPath(import.meta.url))

function scope<T>(configs: readonly T[], files: string[]): Array<T & { files: string[] }> {
  return configs.map((c) => ({ ...(c as object), files }) as T & { files: string[] })
}

export default defineConfig([
  {
    ignores: ['node_modules', 'mcp_server', '.yarn', '.codegraph', 'dist', 'convex/_generated'],
  },
  {
    files: SCOPE,
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        tsconfigRootDir: TSCONFIG_ROOT_DIR,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  ...scope(tseslint.configs.recommended, SCOPE),
  ...scope(convexPlugin.configs.recommended, ['convex/**/*.ts']),
])
