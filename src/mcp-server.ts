#!/usr/bin/env node
/**
 * MCP Server for Diff Review.
 * Connects to the VS Code extension's IPC HTTP server to list, reply, resolve,
 * and delete inline review comments.
 *
 * Usage: node mcp-server.js
 * The port is discovered by pinging every window descriptor in
 * `<tmpdir>/diff-review/` and picking the one whose workspace root matches the
 * caller's cwd (see ipc-discovery.ts) — or via --port to skip discovery.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'path';
import * as os from 'os';
import { descriptorDir } from './ipc-discovery';
import { diagnosticEnvironment, sanitizeDiagnostic } from './agent-diagnostics';
import { postToMcpTarget as ipcPost } from './mcp-target';
import { writeMcpStartupDiagnostic } from './mcp-startup-diagnostics';
import { createMcpSessionRegistrar, defaultMcpSessionRegistrationDependencies } from './mcp-session-registration';
import { registerMcpTools } from './mcp-tool-registration';

// ---------- MCP Server ----------

/**
 * MCP uses stdout for JSON-RPC, so diagnostics must stay on stderr. Coding
 * agents normally capture this stream in their MCP/server logs.
 */
function mcpLog(message: string): void {
  process.stderr.write(`[${new Date().toISOString()}] [diff-review] ${message}\n`);
}

const STARTUP_DIAGNOSTIC_FILE = path.join(descriptorDir(os.tmpdir()), 'mcp-startup-diagnostics.jsonl');

function writeStartupDiagnostic(event: string, details: Record<string, unknown>): void {
  writeMcpStartupDiagnostic(STARTUP_DIAGNOSTIC_FILE, event, details, mcpLog);
}

const sessionRegistrar = createMcpSessionRegistrar(defaultMcpSessionRegistrationDependencies(ipcPost, mcpLog));

/** Construct the reusable MCP application without opening a transport. */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'diff-review',
    version: '0.1.0',
  });
  registerMcpTools(server, sessionRegistrar, mcpLog);
  return server;
}

// ---------- Start ----------

export async function main() {
  const server = createMcpServer();
  writeStartupDiagnostic('process-start', {
    process: {
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      execPath: process.execPath,
      argv: process.argv,
      execArgv: process.execArgv,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      title: process.title,
      uid: process.getuid?.() ?? null,
      gid: process.getgid?.() ?? null,
    },
    environmentKeys: Object.keys(process.env).sort(),
    relevantEnvironment: diagnosticEnvironment(process.env),
  });
  mcpLog(`Starting MCP server (pid ${process.pid}, cwd ${process.cwd()})`);
  mcpLog('Connecting stdio transport');
  server.server.oninitialized = () =>
    writeStartupDiagnostic('mcp-initialized', {
      process: { pid: process.pid, ppid: process.ppid, cwd: process.cwd() },
      client: server.server.getClientVersion() ?? null,
      capabilities: sanitizeDiagnostic(server.server.getClientCapabilities() ?? {}),
    });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLog('MCP server ready');
}

if (require.main === module) {
  main().catch((error: any) => {
    mcpLog(`Fatal startup error: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
