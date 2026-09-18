import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import pkg from './package.json';

const entries = {
  extension: resolve(__dirname, 'src/extension.ts'),
  'mcp-server': resolve(__dirname, 'src/mcp-server.ts'),
  'mcp-launcher': resolve(__dirname, 'src/mcp-launcher.ts'),
} as const;

type EntryName = keyof typeof entries;

function entryFor(mode: string): EntryName {
  if (mode in entries) return mode as EntryName;
  throw new Error(`Unknown build target "${mode}". Use one of: ${Object.keys(entries).join(', ')}.`);
}

export default defineConfig(({ mode }) => {
  const entry = entryFor(mode);

  return {
    // The MCP server bundle has no extension context to read its manifest
    // from, so the package version is baked in at build time instead
    // (`src/version.ts`; its sibling test proves the injected value matches).
    define: {
      __DIFF_REVIEW_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      // jsonc-parser's ESM entry is required for a self-contained VSIX.
      mainFields: ['module', 'main'],
    },
    build: {
      target: 'node18',
      outDir: 'out',
      // `npm run watch` starts one watcher per entry after a clean initial
      // build. A watcher must preserve its siblings' artifacts on startup.
      emptyOutDir: entry === 'extension' && !process.argv.includes('--watch'),
      // This is a Node extension/server bundle, not a browser library build.
      // `noExternal` bundles package dependencies for `vsce --no-dependencies`.
      ssr: entries[entry],
      rollupOptions: {
        external: entry === 'extension' ? ['vscode'] : [],
        output: {
          format: 'cjs',
          inlineDynamicImports: true,
          entryFileNames: `${entry}.js`,
        },
      },
    },
    ssr: { noExternal: true },
  };
});
