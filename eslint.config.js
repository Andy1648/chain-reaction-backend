// ESLint flat config — correctness-focused, deliberately light on style.
// The codebase predates the linter; rules were chosen to catch real bugs
// (undefined vars, unhandled cases) without demanding a reformat.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'gen9.raw.json',
      'gen9.clean.json',
      'coverage/**',
      // Scratch harnesses from parallel overnight sessions (untracked, not ours to lint).
      '*-harness/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Genuine-bug catchers.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': ['warn', { destructuring: 'all' }],
      eqeqeq: ['warn', 'smart'],
      'no-console': 'off', // console IS the logging strategy here (Render captures stdout)
      // Empty catch blocks are used intentionally ("never throw from a handler").
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Test files: node:test's t.mock etc. sometimes leave intentionally unused params.
    files: ['**/*.test.js'],
    rules: {
      'prefer-const': 'off',
    },
  },
];
