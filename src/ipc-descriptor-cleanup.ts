import * as fs from 'fs';
import * as path from 'path';
import { descriptorDir } from './ipc-discovery';

export interface DescriptorCleanupDeps {
  readDirectory(directory: string): string[];
  readFile(filePath: string): string;
  removeFile(filePath: string): void;
  ping(port: number): Promise<boolean>;
  log(message: string): void;
}

const defaultDeps: Omit<DescriptorCleanupDeps, 'ping' | 'log'> = {
  readDirectory: fs.readdirSync,
  readFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
  removeFile: fs.unlinkSync,
};

/** Remove malformed or unreachable per-window IPC descriptors. */
export async function sweepStaleDescriptors(
  tmpDir: string,
  ping: DescriptorCleanupDeps['ping'],
  log: DescriptorCleanupDeps['log'],
  dependencies: Omit<DescriptorCleanupDeps, 'ping' | 'log'> = defaultDeps,
): Promise<void> {
  const directory = descriptorDir(tmpDir);
  let entries: string[];
  try {
    entries = dependencies.readDirectory(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(directory, entry);
    try {
      const descriptor = JSON.parse(dependencies.readFile(filePath)) as { port?: unknown };
      if (typeof descriptor.port !== 'number' || !(await ping(descriptor.port))) {
        dependencies.removeFile(filePath);
        log(`Swept stale IPC descriptor ${entry}`);
      }
    } catch {
      try {
        dependencies.removeFile(filePath);
      } catch {
        // The descriptor was removed by another window.
      }
    }
  }
}
