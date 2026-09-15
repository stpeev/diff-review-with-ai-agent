import { expect, test } from 'vitest';
import { collectMcpInfo, type McpInfoDependencies } from './mcp-info';

function dependencies(overrides: Partial<McpInfoDependencies> = {}): McpInfoDependencies {
  return {
    launcherFile: '/home/me/.diff-review/mcp-launcher.js',
    pointerFile: '/home/me/.diff-review/server-path',
    stateDirectory: '/home/me/.diff-review',
    homeDirectory: () => '/home/me',
    exists: () => true,
    resolveServer: () => ({ path: '/extension/out/mcp-server.js', source: 'pointer', version: '0.12.0' }),
    fromEnvironment: () => undefined,
    fromPointerFile: () => '/extension/out/mcp-server.js',
    ...overrides,
  };
}

const input = {
  extensionPath: '/extension',
  extensionVersion: '0.12.0',
  development: true,
  ipcPort: 4567,
  descriptorPath: '/tmp/diff-review/window.json',
  storageRoot: '/home/me/storage',
  folderCount: 2,
  descriptorDirectory: '/tmp/diff-review',
};

test('reports resolved launcher, pointer, and development diagnostics', () => {
  const rows = collectMcpInfo(input, dependencies());

  expect(rows.map((row) => row.label)).toEqual([
    '$(rocket) Launcher',
    '$(terminal) Add to Claude Code',
    '$(file-symlink-file) Pointer file',
    '$(server) Resolved server',
    '$(vm) This window’s build',
    '$(plug) IPC port',
    '$(database) Comment storage',
  ]);
  expect(rows.find((row) => row.label === '$(rocket) Launcher')?.detail).toContain('~/.diff-review/mcp-launcher.js');
});

test('reports a resolution mismatch and environment override', () => {
  const rows = collectMcpInfo(
    { ...input, development: false },
    dependencies({
      resolveServer: () => ({ path: '/other/out/mcp-server.js', source: 'env' }),
      fromEnvironment: () => '/other/out/mcp-server.js',
    }),
  );

  expect(rows[0]).toEqual({
    label: '$(warning) Consumers resolve a different build than this window',
    detail: 'DIFF_REVIEW_SERVER is set to /other/out/mcp-server.js',
  });
  expect(rows.some((row) => row.label === '$(symbol-variable) DIFF_REVIEW_SERVER')).toBe(true);
});

test('reports resolver failure without treating it as a missing pointer', () => {
  const rows = collectMcpInfo(
    { ...input, development: false },
    dependencies({
      resolveServer: () => {
        throw new Error('no installed server');
      },
      fromPointerFile: () => undefined,
    }),
  );

  expect(rows[0]).toEqual({ label: '$(error) Cannot resolve a server', detail: 'no installed server' });
  expect(rows.find((row) => row.label === '$(file-symlink-file) Pointer file')?.detail).toContain('MISSING');
});
