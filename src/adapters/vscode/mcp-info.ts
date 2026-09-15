import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  LAUNCHER_FILE,
  POINTER_FILE,
  STATE_DIR,
  fromEnv,
  fromPointerFile,
  resolveServer,
  type Resolution,
} from '../../mcp-resolve';

export interface McpInfoRow {
  label: string;
  detail: string;
  copy?: string;
  reveal?: string;
}

export interface McpInfoInput {
  extensionPath: string;
  extensionVersion: string;
  development: boolean;
  ipcPort: number;
  descriptorPath?: string;
  storageRoot: string;
  folderCount: number;
  descriptorDirectory: string;
}

export interface McpInfoDependencies {
  launcherFile: string;
  pointerFile: string;
  stateDirectory: string;
  homeDirectory(): string;
  exists(filePath: string): boolean;
  resolveServer(): Resolution;
  fromEnvironment(): string | null | undefined;
  fromPointerFile(): string | null | undefined;
}

const SOURCE_LABEL: Record<Resolution['source'], string> = {
  env: 'DIFF_REVIEW_SERVER override',
  pointer: 'pointer file written by this extension',
  scan: 'scan of installed extensions',
};

const defaultDependencies: McpInfoDependencies = {
  launcherFile: LAUNCHER_FILE,
  pointerFile: POINTER_FILE,
  stateDirectory: STATE_DIR,
  homeDirectory: os.homedir,
  exists: fs.existsSync,
  resolveServer,
  fromEnvironment: fromEnv,
  fromPointerFile,
};

/** Build data for the MCP server information picker without creating VS Code UI. */
export function collectMcpInfo(
  input: McpInfoInput,
  dependencies: McpInfoDependencies = defaultDependencies,
): McpInfoRow[] {
  const rows: McpInfoRow[] = [];
  const ownServer = path.join(input.extensionPath, 'out', 'mcp-server.js');
  const short = (filePath: string) => {
    const home = dependencies.homeDirectory();
    return filePath.startsWith(home + path.sep) ? '~' + filePath.slice(home.length) : filePath;
  };
  const exists = (filePath: string) => (dependencies.exists(filePath) ? 'exists' : 'MISSING');

  let resolved: Resolution | null = null;
  let resolveError = '';
  try {
    resolved = dependencies.resolveServer();
  } catch (error: any) {
    resolveError = error.message;
  }
  if (resolved && resolved.path !== ownServer) {
    const why =
      resolved.source === 'env'
        ? `DIFF_REVIEW_SERVER is set to ${short(resolved.path)}`
        : resolved.source === 'pointer'
          ? `the pointer file points at ${short(resolved.path)} — another window may have written it`
          : `no pointer file matched, so the scan picked ${short(resolved.path)}`;
    rows.push({ label: '$(warning) Consumers resolve a different build than this window', detail: why });
  } else if (!resolved) {
    rows.push({ label: '$(error) Cannot resolve a server', detail: resolveError });
  }
  rows.push({
    label: '$(rocket) Launcher',
    detail: `${short(dependencies.launcherFile)} — ${exists(dependencies.launcherFile)} · point your MCP consumer here`,
    copy: dependencies.launcherFile,
    reveal: dependencies.launcherFile,
  });
  rows.push({
    label: '$(terminal) Add to Claude Code',
    detail: `claude mcp add diff-review node ${short(dependencies.launcherFile)}`,
    copy: `claude mcp add diff-review node ${dependencies.launcherFile}`,
  });
  const envOverride = dependencies.fromEnvironment();
  if (envOverride) {
    rows.push({
      label: '$(symbol-variable) DIFF_REVIEW_SERVER',
      detail: `${short(envOverride)} — ${exists(envOverride)}`,
      copy: envOverride,
    });
  }
  const pointer = dependencies.fromPointerFile();
  rows.push({
    label: '$(file-symlink-file) Pointer file',
    detail: pointer
      ? `${short(dependencies.pointerFile)} → ${short(pointer)} — ${exists(pointer)}`
      : `${short(dependencies.pointerFile)} — MISSING · activate the extension once to write it`,
    copy: dependencies.pointerFile,
    reveal: dependencies.stateDirectory,
  });
  if (resolved) {
    rows.push({
      label: '$(server) Resolved server',
      detail: `${short(resolved.path)} — via ${SOURCE_LABEL[resolved.source]}${resolved.version ? ` · v${resolved.version}` : ''}`,
      copy: resolved.path,
      reveal: resolved.path,
    });
  }
  if (input.development) {
    rows.push({
      label: '$(vm) This window’s build',
      detail: `${short(ownServer)} — v${input.extensionVersion} · ${exists(ownServer)}`,
      copy: ownServer,
      reveal: ownServer,
    });
    rows.push({
      label: '$(plug) IPC port',
      detail: input.ipcPort
        ? `${input.ipcPort} — descriptor at ${short(input.descriptorPath ?? '')}`
        : `not listening — ${short(input.descriptorDirectory)} may be stale`,
      copy: input.ipcPort ? String(input.ipcPort) : undefined,
    });
    rows.push({
      label: '$(database) Comment storage',
      detail: `${short(input.storageRoot)} — ${input.folderCount} folder(s) tracked`,
      copy: input.storageRoot,
      reveal: input.storageRoot,
    });
  }
  return rows;
}
