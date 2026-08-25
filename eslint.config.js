import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import noCoreToAdapters from './tools/eslint-rules/no-core-to-adapters.js'

/** Local plugin holding Driftwatch's architectural rules. */
const driftwatch = {
  rules: {
    'no-core-to-adapters': noCoreToAdapters,
  },
}

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'fixtures/**', '.perf/**', 'coverage/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { driftwatch },
    rules: {
      // Hard rule 1 — the architectural boundary. Error, so `npm run lint` fails the build.
      'driftwatch/no-core-to-adapters': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'off',
    },
  },

  // Local ESLint rules and demo scripts are plain Node ESM, linted as JS.
  {
    files: ['tools/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
)
