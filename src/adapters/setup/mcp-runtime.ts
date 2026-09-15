import * as fs from 'node:fs';
import * as path from 'node:path';
import { LAUNCHER_FILE, POINTER_FILE, STATE_DIR } from '../../mcp-resolve';

export interface McpRuntimePaths {
  stateDir: string;
  pointerFile: string;
  launcherFile: string;
  storagePathFile: string;
}

export const defaultMcpRuntimePaths: McpRuntimePaths = {
  stateDir: STATE_DIR,
  pointerFile: POINTER_FILE,
  launcherFile: LAUNCHER_FILE,
  storagePathFile: path.join(STATE_DIR, 'storage-path'),
};

export type SetupResult = { ok: true } | { ok: false; error: unknown };

/** Deploy the standalone launcher and pointer that survive a versioned VS Code install path. */
export function deployMcpLauncher(extensionPath: string, paths = defaultMcpRuntimePaths): SetupResult {
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.pointerFile, path.join(extensionPath, 'out', 'mcp-server.js'), 'utf-8');
    fs.copyFileSync(path.join(extensionPath, 'out', 'mcp-launcher.js'), paths.launcherFile);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Persist the extension storage root for future offline storage readers. */
export function deployStoragePathPointer(globalStoragePath: string, paths = defaultMcpRuntimePaths): SetupResult {
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.storagePathFile, globalStoragePath, 'utf-8');
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
