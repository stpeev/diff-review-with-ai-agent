import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { deployMcpLauncher, deployStoragePathPointer, type McpRuntimePaths } from './mcp-runtime';

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runtimePaths(root: string): McpRuntimePaths {
  const stateDir = path.join(root, 'state');
  return {
    stateDir,
    pointerFile: path.join(stateDir, 'server-path'),
    launcherFile: path.join(stateDir, 'mcp-launcher.js'),
    storagePathFile: path.join(stateDir, 'storage-path'),
  };
}

test('launcher deployment copies the standalone bundle and writes its server pointer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-runtime-'));
  temporaryDirs.push(root);
  const extension = path.join(root, 'extension');
  fs.mkdirSync(path.join(extension, 'out'), { recursive: true });
  fs.writeFileSync(path.join(extension, 'out', 'mcp-launcher.js'), 'launcher bundle');
  const paths = runtimePaths(root);

  expect(deployMcpLauncher(extension, paths)).toEqual({ ok: true });
  expect(fs.readFileSync(paths.pointerFile, 'utf8')).toBe(path.join(extension, 'out', 'mcp-server.js'));
  expect(fs.readFileSync(paths.launcherFile, 'utf8')).toBe('launcher bundle');
});

test('storage path deployment writes independently from launcher deployment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-review-runtime-'));
  temporaryDirs.push(root);
  const paths = runtimePaths(root);

  expect(deployStoragePathPointer('/storage/root', paths)).toEqual({ ok: true });
  expect(fs.readFileSync(paths.storagePathFile, 'utf8')).toBe('/storage/root');
});
