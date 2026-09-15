import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { codexThreadIdFromMeta } from './agent-registry';
import { getIpcJson } from './protocol/client';
import { postToMcpTarget as ipcPost, resolveMcpTarget } from './mcp-target';
import type { McpSessionRegistrar } from './mcp-session-registration';

type TextToolResult = { content: { type: 'text'; text: string }[] };

/** Keeps the MCP SDK generic boundary away from the application adapter. */
interface BoundedToolRegistrar {
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    callback: (input: Record<string, unknown>, extra: { _meta?: Record<string, unknown> }) => Promise<TextToolResult>,
  ): unknown;
}

export function registerMcpTools(
  server: McpServer,
  registrar: McpSessionRegistrar,
  log: (message: string) => void,
): void {
  const boundedTools = server as unknown as BoundedToolRegistrar;
  let lastReviewGeneration = 0;

  const registerAgentSessionInput = z.object({
    label: z.string().optional().describe('A short human-readable name for this conversation, derived from its topic'),
  });

  boundedTools.tool(
    'registerAgentSession',
    'Register this agent conversation as a target for direct Diff Review delivery',
    { label: registerAgentSessionInput.shape.label },
    async (input, extra) => {
      const { label } = registerAgentSessionInput.parse(input);
      const codexSessionId = codexThreadIdFromMeta(extra._meta);
      const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
      if (!codexSessionId && !claudeSessionId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Could not register this agent session: no supported Claude session ID or Codex thread ID was available.',
            },
          ],
        };
      }
      const agent = codexSessionId ? 'Codex' : 'Claude';
      const sessionId = codexSessionId ?? claudeSessionId!;
      const outcome = codexSessionId
        ? await registrar.registerCodexSession(codexSessionId, label)
        : await registrar.registerClaudeSession(claudeSessionId!, label);
      return {
        content: [
          {
            type: 'text' as const,
            text: outcome.ok
              ? `Registered ${agent} session "${outcome.label ?? sessionId.slice(-6)}" for direct Diff Review delivery.`
              : `Could not register this ${agent} session: ${outcome.error}`,
          },
        ],
      };
    },
  );

  boundedTools.tool(
    'unregisterAgentSession',
    'Remove this agent conversation as a target for direct Diff Review delivery',
    {},
    async (_input, extra) => {
      const codexSessionId = codexThreadIdFromMeta(extra._meta);
      const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
      if (!codexSessionId && !claudeSessionId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Could not unregister this agent session: no supported Claude session ID or Codex thread ID was available.',
            },
          ],
        };
      }
      const agent = codexSessionId ? 'Codex' : 'Claude';
      const sessionId = codexSessionId ?? claudeSessionId!;
      try {
        await ipcPost('/session/unregister', { sessionId });
        registrar.clear(sessionId);
        log(`Unregistered agent session ${agent.toLowerCase()}:${sessionId.slice(-6)}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unregistered ${agent} session ${sessionId.slice(-6)} from direct Diff Review delivery.`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            { type: 'text' as const, text: `Could not unregister this ${agent} session: ${error.message ?? error}` },
          ],
        };
      }
    },
  );

  // Tool 1: List comments
  boundedTools.tool(
    'listDiffComments',
    'List all inline review comments with their IDs, file locations, status, and thread text',
    {},
    async () => {
      try {
        const target = await resolveMcpTarget();
        const state = await getIpcJson<{
          threads?: {
            id: number;
            uri: string;
            startLine: number;
            status: string;
            comments: { role: string; body: string }[];
          }[];
        }>('/comments', target);
        if (!state.threads || state.threads.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No review comments.' }] };
        }
        const lines = state.threads.map((t: any) => {
          const comments = t.comments.map((c: any) => `  [${c.role}] ${c.body}`).join('\n');
          const location =
            t.status === 'drifted' ? `DRIFTED (was ${t.uri}:${t.startLine + 1})` : `${t.uri}:${t.startLine + 1}`;
          return `#${t.id} | ${location} | ${t.status.toUpperCase()}\n${comments}`;
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
      }
    },
  );

  boundedTools.tool(
    'awaitReview',
    'Wait for the user to send review comments, then return an instruction to list and address them',
    {},
    async () => {
      try {
        const target = await resolveMcpTarget();
        const result = await getIpcJson<{ pending?: boolean; generation?: number }>(
          `/review/await?since=${lastReviewGeneration}`,
          target,
          50000,
        );
        lastReviewGeneration = result.generation ?? lastReviewGeneration;
        return {
          content: [
            {
              type: 'text' as const,
              text: result.pending
                ? 'Review comments are pending. Call listDiffComments now and address every open thread.'
                : 'No review arrived yet. Call awaitReview again when ready.',
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error waiting for review: ${e.message}` }] };
      }
    },
  );

  // Tool 2: Create comment
  const createDiffCommentInput = z.object({
    path: z.string().describe('Workspace-relative file path, e.g. "src/foo.ts"'),
    line: z.number().describe('1-based line number to attach the comment to'),
    endLine: z.number().optional().describe('1-based end line, for a multi-line range. Defaults to `line`.'),
    text: z.string().describe('The comment text'),
  });

  boundedTools.tool(
    'createDiffComment',
    'Create a new inline review comment thread at a file/line, as if typed into the editor gutter. Use this to leave review feedback for another agent (or yourself) to address later.',
    createDiffCommentInput.shape,
    async (input) => {
      const { path: filePath, line, endLine, text } = createDiffCommentInput.parse(input);
      try {
        const result = await ipcPost<{ threadId: number }>('/create', { path: filePath, line, endLine, text });
        return {
          content: [
            { type: 'text' as const, text: `Created comment thread #${result.threadId} at ${filePath}:${line}.` },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
      }
    },
  );

  // Tool 3: Reply to comment
  const replyToDiffCommentInput = z.object({
    threadId: z.number().describe('The thread ID from listDiffComments (e.g. 1, 2)'),
    text: z.string().describe('The reply text'),
  });

  boundedTools.tool(
    'replyToDiffComment',
    'Reply to an existing inline review comment thread as the agent role',
    replyToDiffCommentInput.shape,
    async (input) => {
      const { threadId, text } = replyToDiffCommentInput.parse(input);
      try {
        await ipcPost('/reply', { threadId, text });
        return { content: [{ type: 'text' as const, text: `Replied to thread #${threadId}.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
      }
    },
  );

  // Tool 4: Resolve comment
  const resolveDiffCommentInput = z.object({
    threadId: z.number().describe('The thread ID to resolve'),
  });

  boundedTools.tool(
    'resolveDiffComment',
    'Mark an inline review comment as resolved/done',
    resolveDiffCommentInput.shape,
    async (input) => {
      const { threadId } = resolveDiffCommentInput.parse(input);
      try {
        await ipcPost('/resolve', { threadId });
        return { content: [{ type: 'text' as const, text: `Thread #${threadId} resolved.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
      }
    },
  );

  // Tool 5: Delete comment
  const deleteDiffCommentInput = z.object({
    threadId: z.number().describe('The thread ID to delete'),
  });

  boundedTools.tool(
    'deleteDiffComment',
    'Delete an inline review comment thread entirely',
    deleteDiffCommentInput.shape,
    async (input) => {
      const { threadId } = deleteDiffCommentInput.parse(input);
      try {
        await ipcPost('/delete', { threadId });
        return { content: [{ type: 'text' as const, text: `Thread #${threadId} deleted.` }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }] };
      }
    },
  );
}
