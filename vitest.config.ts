import { defineConfig } from 'vitest/config';
import pkg from './package.json';

export default defineConfig({
  // Mirror the production Vite define so tests see the real injected version
  // (`src/version.ts`); its sibling test asserts it matches the manifest.
  define: {
    __DIFF_REVIEW_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.integration.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/extension.ts', 'src/mcp-server.ts', 'src/mcp-launcher.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
