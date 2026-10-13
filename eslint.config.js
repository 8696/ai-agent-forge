import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'data/**',
      'logs/**',
      'coverage/**',
      '.husky/**',
      '*.js',
      'commitlint.config.js'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2023,
      sourceType: 'module'
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'off'
    }
  }
];
