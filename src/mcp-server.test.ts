import { expect, test } from 'vitest';
import { createMcpServer } from './mcp-server';

test('createMcpServer constructs the tool server without connecting a transport', () => {
  const server = createMcpServer();

  expect(server).toBeDefined();
  expect(server.server).toBeDefined();
});
