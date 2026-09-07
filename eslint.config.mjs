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
        __OSG_E2E_AUTOMATION__: 'readonly',
      },
    },
    rules: {
      'react/jsx-uses-vars': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'no-restricted-globals': ['error',
        { name: 'alert', message: 'Use the non-blocking application toast surface.' },
        { name: 'confirm', message: 'Use an application-owned confirmation surface.' },
        { name: 'prompt', message: 'Use an application-owned input surface.' },
      ],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'alert', message: 'Use the non-blocking application toast surface.' },
        { object: 'window', property: 'confirm', message: 'Use an application-owned confirmation surface.' },
        { object: 'window', property: 'prompt', message: 'Use an application-owned input surface.' },
      ],
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
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
];
