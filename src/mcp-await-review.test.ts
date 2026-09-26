import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, test, vi } from 'vitest';

const getFromMcpTarget = vi.fn();
vi.mock('./mcp-target', () => ({ getFromMcpTarget, postToMcpTarget: vi.fn() }));

test('awaitReview counts generations from 0 again after the target changes', async () => {
  const { registerMcpTools } = await import('./mcp-tool-registration');
  const callbacks = new Map<string, () => Promise<unknown>>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, callback: () => Promise<unknown>) => callbacks.set(name, callback),
  } as unknown as McpServer;
  let changed = () => {};
  registerMcpTools(server, {} as never, vi.fn(), {
    reconnect: vi.fn(),
    onTargetChanged: (listener) => (changed = () => listener({} as never, {} as never)),
  });
  const awaitReview = callbacks.get('awaitReview')!;

  getFromMcpTarget.mockResolvedValue({ pending: false, generation: 7 });
  await awaitReview();
  await awaitReview();
  expect(getFromMcpTarget).toHaveBeenLastCalledWith('/review/await?since=7', 50000);

  changed();
  await awaitReview();
  expect(getFromMcpTarget).toHaveBeenLastCalledWith('/review/await?since=0', 50000);
});
