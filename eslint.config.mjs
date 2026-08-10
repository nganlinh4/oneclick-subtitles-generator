import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: [
      'build/**',
      'node_modules/**',
      'promptdj-midi/**',
      'public/**',
      'video-renderer/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}', 'vite.config.mjs', 'vitest.config.mjs'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: ['src/**/*.{test,spec}.{js,jsx}', 'src/setupTests.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
        vi: 'readonly',
      },
    },
  },
];
