import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, test, vi } from 'vitest';
import { registerMcpTools } from './mcp-tool-registration';
import type { McpSessionRegistrar, RegistrationOutcome } from './mcp-session-registration';

type ToolCallback = (
  input: Record<string, unknown>,
  extra: { _meta?: Record<string, unknown> },
) => Promise<{
  content: { type: 'text'; text: string }[];
}>;

function registeredTools() {
  const callbacks = new Map<string, ToolCallback>();
  const server = {
    tool(name: string, _description: string, _schema: unknown, callback: ToolCallback) {
      callbacks.set(name, callback);
    },
  } as unknown as McpServer;
  const outcome: RegistrationOutcome = { ok: true, label: 'Topic review' };
  const registrar: McpSessionRegistrar = {
    registerCodexSession: vi.fn().mockResolvedValue(outcome),
    registerClaudeSession: vi.fn().mockResolvedValue(outcome),
    replayAll: vi.fn().mockResolvedValue([]),
    clear: vi.fn(),
  };
  const targets = {
    reconnect: vi.fn().mockResolvedValue({ port: 1234, matchedRoot: '/workspace', source: 'cwd-match' }),
    onTargetChanged: vi.fn(),
  };
  registerMcpTools(server, registrar, vi.fn(), targets);
  return { callbacks, registrar, targets };
}

test('registers the complete public MCP tool set', () => {
  const { callbacks } = registeredTools();

  expect([...callbacks.keys()]).toEqual([
    'registerAgentSession',
    'unregisterAgentSession',
    'listDiffComments',
    'awaitReview',
    'createDiffComment',
    'replyToDiffComment',
    'resolveDiffComment',
    'deleteDiffComment',
  ]);
});

test('routes Codex registration metadata through the session registrar', async () => {
  const { callbacks, registrar } = registeredTools();
  const register = callbacks.get('registerAgentSession');

  const result = await register?.({ label: '  Topic review  ' }, { _meta: { threadId: 'thread-123456' } });

  expect(registrar.registerCodexSession).toHaveBeenCalledWith('thread-123456', '  Topic review  ', { force: true });
  expect(result?.content[0].text).toBe('Registered Codex session "Topic review" for direct Diff Review delivery.');
});

test('reconnects before registering so an explicit register always starts fresh', async () => {
  const { callbacks, registrar, targets } = registeredTools();

  await callbacks.get('registerAgentSession')?.({}, { _meta: { threadId: 'thread-123456' } });

  expect(targets.reconnect).toHaveBeenCalledOnce();
  expect(targets.reconnect.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(registrar.registerCodexSession).mock.invocationCallOrder[0],
  );
});

test('reports a failed reconnect without registering', async () => {
  const { callbacks, registrar, targets } = registeredTools();
  targets.reconnect.mockRejectedValue(new Error('Multiple Diff Review windows are running'));

  const result = await callbacks.get('registerAgentSession')?.({}, { _meta: { threadId: 'thread-123456' } });

  expect(result?.content[0].text).toBe(
    'Could not register this Codex session: Multiple Diff Review windows are running',
  );
  expect(registrar.registerCodexSession).not.toHaveBeenCalled();
});
