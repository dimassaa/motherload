import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/',
      'coverage/',
      'backups/',
      'tmp/',
      'public/vendor/',
      'public/fonts/',
      'public/img/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Pino is the only allowed output channel; console bypasses structured logging.
      'no-console': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
];
