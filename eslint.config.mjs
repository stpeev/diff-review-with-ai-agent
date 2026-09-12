import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'node_modules/**',
      'coverage/**',
      '.sandbox/**',
      '.vscode-test/**',
      'examples/**',
      'scripts/**',
      '*.js',
      '*.vsix',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      'prefer-const': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['src/review/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vscode', message: 'Review domain modules must not depend on VS Code.' },
            { name: 'node:fs', message: 'Review domain modules must not access the filesystem.' },
            { name: 'node:fs/promises', message: 'Review domain modules must not access the filesystem.' },
            { name: 'node:http', message: 'Review domain modules must not create HTTP transports.' },
            { name: 'node:net', message: 'Review domain modules must not create socket transports.' },
            { name: 'node:child_process', message: 'Review domain modules must not start processes.' },
            { name: 'node:process', message: 'Review domain modules must not access process globals.' },
            { name: '@modelcontextprotocol/sdk', message: 'Review domain modules must not depend on MCP.' },
          ],
          patterns: [
            {
              group: ['../adapters/**', '../extension', '../mcp-*'],
              message: 'Review domain modules must not depend on adapters or runtime entry points.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/storage/**/*.ts', 'src/protocol/**/*.ts', 'src/workspace/**/*.ts', 'src/agents/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vscode', message: 'Core modules must not depend on VS Code.' },
            { name: '@modelcontextprotocol/sdk', message: 'Core modules must not depend on MCP.' },
          ],
          patterns: [
            {
              group: ['../adapters/**', '../extension', '../mcp-*'],
              message: 'Core modules must not depend on adapters or runtime entry points.',
            },
          ],
        },
      ],
    },
  },
);
