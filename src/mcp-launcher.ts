#!/usr/bin/env node
/**
 * Diff Review MCP launcher.
 *
 * VS Code installs extensions into a directory whose name contains the version
 * (e.g. jinqishen.diff-review-0.3.0), so that path breaks on every upgrade.
 * This launcher lives at a stable path and resolves the current server at
 * runtime, in order of preference:
 *
 *   1. DIFF_REVIEW_SERVER env var (explicit override, e.g. a local dev build)
 *   2. ~/.diff-review/server-path — written by the extension on activation
 *   3. A scan of the known extension directories, picking the highest version
 *
 * The rules themselves live in mcp-resolve.ts, shared with the extension's
 * "Show MCP Server Info" command.
 *
 * Built to out/mcp-launcher.js and copied to ~/.diff-review on activation;
 * point your MCP client at that copy:
 *   claude mcp add diff-review node ~/.diff-review/mcp-launcher.js
 */
import { createRequire } from 'module';
import { resolveServer } from './mcp-resolve';

function fail(message: string): never {
  // stdout is the MCP transport, so diagnostics must go to stderr.
  process.stderr.write(`[diff-review] ${message}\n`);
  process.exit(1);
}

try {
  // The path is only known at runtime, so this has to be a real require
  // rather than an import the bundler would try to follow.
  const loaded = createRequire(__filename)(resolveServer().path);
  // Requiring the server leaves `require.main` pointing here, so its own
  // entry-point guard never fires — start it explicitly.
  if (typeof loaded?.main === 'function') {
    loaded.main().catch((err: any) => fail(err?.stack ?? err?.message ?? String(err)));
  }
} catch (err: any) {
  fail(err.message);
}
