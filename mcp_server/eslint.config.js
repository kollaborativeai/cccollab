import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import { defineConfig } from 'eslint/config'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// typescript-eslint's parser walks up from the file to find a tsconfig,
// and errors out when two candidates exist (repo root + workspace).
// Pinning `tsconfigRootDir` to THIS workspace's directory makes the
// workspace config unambiguous even when lint-staged invokes eslint from
// the repo root with mixed-workspace paths.
const TSCONFIG_ROOT_DIR = dirname(fileURLToPath(import.meta.url))

export default defineConfig([
  {
    ignores: ['dist', '.yarn', '.codegraph', 'i', 'node_modules'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.ts'],
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
])
