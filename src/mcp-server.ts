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
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import {
    Descriptor, descriptorDir, resolvePort, ResolveResult,
    NoServerError, AmbiguousPortError,
} from './ipc-discovery';

// ---------- IPC target resolution ----------

function portFlag(): number | undefined {
    const idx = process.argv.indexOf('--port');
    if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
    return undefined;
}

function readAllDescriptors(tmpDir: string): Descriptor[] {
    let entries: string[];
    try {
        entries = fs.readdirSync(descriptorDir(tmpDir));
    } catch {
        return [];
    }
    const out: Descriptor[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
            const d = JSON.parse(fs.readFileSync(path.join(descriptorDir(tmpDir), entry), 'utf-8'));
            if (typeof d.port === 'number') out.push(d);
        } catch {
            // Ignore unreadable/partial files — the owning window sweeps these.
        }
    }
    return out;
}

function pingDescriptor(port: number, timeoutMs = 800): Promise<boolean> {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/ping`, res => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    });
}

const LEGACY_PORT_FILE = path.join(os.tmpdir(), 'diff-review-port');

function legacyPort(): number | null {
    try {
        return parseInt(fs.readFileSync(LEGACY_PORT_FILE, 'utf-8').trim(), 10);
    } catch {
        return null;
    }
}

let cachedTarget: ResolveResult | null = null;

/**
 * Resolve which window's IPC server to talk to, once per process (an MCP
 * server instance handles many tool calls, so this is cached rather than
 * re-resolved per call). `--port` short-circuits everything else.
 */
async function resolveTarget(): Promise<ResolveResult> {
    if (cachedTarget) return cachedTarget;

    const flag = portFlag();
    if (flag !== undefined) {
        cachedTarget = { port: flag, matchedRoot: null, source: 'flag' };
        return cachedTarget;
    }

    const candidates = readAllDescriptors(os.tmpdir());
    const alivePings = await Promise.all(candidates.map(d => pingDescriptor(d.port)));
    const alive = candidates.filter((_, i) => alivePings[i]);

    try {
        cachedTarget = resolvePort(alive, { cwd: process.cwd() });
        return cachedTarget;
    } catch (e) {
        if (e instanceof AmbiguousPortError) throw e;
        if (!(e instanceof NoServerError)) throw e;
    }

    // Fall back to the deprecated single-window pointer, for a window still
    // running a pre-F1 build. Multiple such windows would silently misroute —
    // that is exactly the bug this whole mechanism replaces — so this path
    // only exists for a one-release upgrade grace period.
    const legacy = legacyPort();
    if (legacy !== null && await pingLegacy(legacy)) {
        process.stderr.write(
            '[diff-review] Warning: resolved via the deprecated global port file. ' +
            'If multiple VS Code windows are open, this may be the wrong one. Update the extension to fix this.\n'
        );
        cachedTarget = { port: legacy, matchedRoot: null, source: 'sole-live' };
        return cachedTarget;
    }

    throw new NoServerError();
}

function pingLegacy(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/health`, res => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
    });
}

// ---------- IPC Client ----------

function ipcGet(endpoint: string, port: number, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${endpoint}`, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('IPC request timeout')); });
    });
}

async function ipcPost(endpoint: string, data: any): Promise<any> {
    const target = await resolveTarget();
    const body = JSON.stringify({ ...data, expectWorkspaceRoot: target.matchedRoot ?? undefined });
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: target.port,
            path: endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const result = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    if (res.statusCode === 409) {
                        reject(new Error(
                            `This request was routed to a window scoped to [${(result.have ?? []).join(', ') || 'no workspace folder'}], ` +
                            `not the workspace this call expected (${target.matchedRoot}). Another VS Code window may own your comments — ` +
                            'run "Diff Review: Show MCP Server Info" to check.'
                        ));
                    } else if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(result.error || `HTTP ${res.statusCode}`));
                    } else {
                        resolve(result);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('IPC request timeout')); });
        req.write(body);
        req.end();
    });
}

// ---------- MCP Server ----------

const server = new McpServer({
    name: 'diff-review',
    version: '0.1.0',
});
let lastReviewGeneration = 0;

// Tool 1: List comments
server.tool(
    'listDiffComments',
    'List all inline review comments with their IDs, file locations, status, and thread text',
    {},
    async () => {
        try {
            const target = await resolveTarget();
            const state = await ipcGet('/comments', target.port);
            if (!state.threads || state.threads.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No review comments.' }] };
            }
            const lines = state.threads.map((t: any) => {
                const comments = t.comments.map((c: any) => `  [${c.role}] ${c.body}`).join('\n');
                const location = t.status === 'drifted' ? `DRIFTED (was ${t.uri}:${t.startLine + 1})` : `${t.uri}:${t.startLine + 1}`;
                return `#${t.id} | ${location} | ${t.status.toUpperCase()}\n${comments}`;
            });
            return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
        }
    }
);

server.tool(
    'awaitReview',
    'Wait for the user to send review comments, then return an instruction to list and address them',
    {},
    async () => {
        try {
            const target = await resolveTarget();
            const result = await ipcGet(`/review/await?since=${lastReviewGeneration}`, target.port, 50000);
            lastReviewGeneration = result.generation ?? lastReviewGeneration;
            return { content: [{ type: 'text' as const, text: result.pending
                ? 'Review comments are pending. Call listDiffComments now and address every open thread.'
                : 'No review arrived yet. Call awaitReview again when ready.' }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error waiting for review: ${e.message}` }] };
        }
    }
);

// Tool 2: Create comment
server.tool(
    'createDiffComment',
    'Create a new inline review comment thread at a file/line, as if typed into the editor gutter. Use this to leave review feedback for another agent (or yourself) to address later.',
    {
        path: z.string().describe('Workspace-relative file path, e.g. "src/foo.ts"'),
        line: z.number().describe('1-based line number to attach the comment to'),
        endLine: z.number().optional().describe('1-based end line, for a multi-line range. Defaults to `line`.'),
        text: z.string().describe('The comment text'),
    },
    async ({ path: filePath, line, endLine, text }) => {
        try {
            const result = await ipcPost('/create', { path: filePath, line, endLine, text });
            return { content: [{ type: 'text' as const, text: `Created comment thread #${result.threadId} at ${filePath}:${line}.` }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
        }
    }
);

// Tool 3: Reply to comment
server.tool(
    'replyToDiffComment',
    'Reply to an existing inline review comment thread as the agent role',
    {
        threadId: z.number().describe('The thread ID from listDiffComments (e.g. 1, 2)'),
        text: z.string().describe('The reply text'),
    },
    async ({ threadId, text }) => {
        try {
            await ipcPost('/reply', { threadId, text });
            return { content: [{ type: 'text' as const, text: `Replied to thread #${threadId}.` }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
        }
    }
);

// Tool 4: Resolve comment
server.tool(
    'resolveDiffComment',
    'Mark an inline review comment as resolved/done',
    {
        threadId: z.number().describe('The thread ID to resolve'),
    },
    async ({ threadId }) => {
        try {
            await ipcPost('/resolve', { threadId });
            return { content: [{ type: 'text' as const, text: `Thread #${threadId} resolved.` }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
        }
    }
);

// Tool 5: Delete comment
server.tool(
    'deleteDiffComment',
    'Delete an inline review comment thread entirely',
    {
        threadId: z.number().describe('The thread ID to delete'),
    },
    async ({ threadId }) => {
        try {
            await ipcPost('/delete', { threadId });
            return { content: [{ type: 'text' as const, text: `Thread #${threadId} deleted.` }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
        }
    }
);

// ---------- Start ----------

async function main() {
    const agent = process.env.CLAUDE_CODE_SESSION_ID ? 'claude' : process.env.CODEX_THREAD_ID ? 'codex' : undefined;
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID;
    if (agent && sessionId) {
        try {
            await ipcPost('/session/register', {
                agent, sessionId, cwd: process.cwd(),
                label: agent === 'claude' ? `claude-${process.env.CLAUDE_PID || sessionId.slice(-6)}` : `codex-${sessionId.slice(-6)}`,
                socketPath: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
                token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
                pid: process.env.CLAUDE_PID ? Number(process.env.CLAUDE_PID) : undefined,
            });
        } catch (error: any) {
            process.stderr.write(`[diff-review] Session registration failed: ${error.message}\n`);
        }
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(console.error);
