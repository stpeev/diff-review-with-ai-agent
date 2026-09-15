import * as fs from 'fs';
import * as path from 'path';
import { descriptorDir, descriptorPath, type Descriptor } from './ipc-discovery';

export interface DescriptorWriterInput {
  tmpDir: string;
  workspaceRoots: string[];
  port: number;
  processId: number;
  previousPath?: string;
}

export interface DescriptorWriterDeps {
  mkdir(directory: string): void;
  writeFile(filePath: string, content: string): void;
  removeFile(filePath: string): void;
  now(): string;
  log(message: string): void;
}

const defaultDeps: Omit<DescriptorWriterDeps, 'log'> = {
  mkdir: (directory) => fs.mkdirSync(directory, { recursive: true }),
  writeFile: (filePath, content) => fs.writeFileSync(filePath, content, 'utf-8'),
  removeFile: fs.unlinkSync,
  now: () => new Date().toISOString(),
};

/** Publish a window descriptor and retain the deprecated global port pointer for one compatibility release. */
export function writeIpcDescriptor(
  input: DescriptorWriterInput,
  log: DescriptorWriterDeps['log'],
  dependencies: Omit<DescriptorWriterDeps, 'log'> = defaultDeps,
): string {
  if (input.previousPath) {
    try {
      dependencies.removeFile(input.previousPath);
    } catch {
      // It may already have been cleaned up during shutdown.
    }
  }
  const directory = descriptorDir(input.tmpDir);
  dependencies.mkdir(directory);
  const descriptor: Descriptor = {
    port: input.port,
    workspaceRoots: input.workspaceRoots,
    pid: input.processId,
    startedAt: dependencies.now(),
  };
  const filePath = descriptorPath(input.tmpDir, input.workspaceRoots, input.processId);
  dependencies.writeFile(filePath, JSON.stringify(descriptor));
  dependencies.writeFile(path.join(input.tmpDir, 'diff-review-port'), String(input.port));
  log('Wrote deprecated global IPC port pointer; MCP clients should use per-window descriptors.');
  return filePath;
}
