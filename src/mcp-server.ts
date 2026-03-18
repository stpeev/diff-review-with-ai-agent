#!/usr/bin/env node
/**
 * MCP Server for Diff Review.
 * Connects to the VS Code extension's IPC HTTP server to list, reply, resolve,
 * and delete inline review comments.
 *
 * Usage: node mcp-server.js
 * The port is discovered via ~/tmp/diff-review-port or --port flag.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

// ---------- IPC Client ----------

function getPort(): number {
    // Check --port flag
    const portIdx = process.argv.indexOf('--port');
    if (portIdx !== -1 && process.argv[portIdx + 1]) {
        return parseInt(process.argv[portIdx + 1], 10);
    }
    // Read from port file
    const portFile = path.join(os.tmpdir(), 'diff-review-port');
    if (fs.existsSync(portFile)) {
        return parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
    }
    throw new Error('Cannot find Diff Review IPC port. Is the VS Code extension running?');
}

function ipcGet(endpoint: string): Promise<any> {
    const port = getPort();
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
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('IPC request timeout')); });
    });
}

function ipcPost(endpoint: string, data: any): Promise<any> {
    const port = getPort();
    const body = JSON.stringify(data);
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: endpoint,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const result = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
                    if (res.statusCode && res.statusCode >= 400) {
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

// Tool 1: List comments
server.tool(
    'listDiffComments',
    'List all inline review comments with their IDs, file locations, status, and thread text',
    {},
    async () => {
        try {
            const state = await ipcGet('/comments');
            if (!state.threads || state.threads.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No review comments.' }] };
            }
            const lines = state.threads.map((t: any) => {
                const comments = t.comments.map((c: any) => `  [${c.role}] ${c.body}`).join('\n');
                return `#${t.id} | ${t.uri}:${t.startLine + 1} | ${t.status.toUpperCase()}\n${comments}`;
            });
            return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
        }
    }
);

// Tool 2: Reply to comment
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

// Tool 3: Resolve comment
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

// Tool 4: Delete comment
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
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(console.error);
