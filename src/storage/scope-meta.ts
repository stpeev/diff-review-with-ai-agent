import * as path from 'path';
import type { ScopeFile } from '../comment-store';

export interface ScopeMetaInput {
  scopeId: string;
  folderPath: string;
  scopeDirectory: string;
  file: ScopeFile;
}

export interface ScopeMetaWriter {
  writeAtomic(filePath: string, content: string): void;
}

/** Write advisory metadata for recovery and diagnostics without affecting the scope commit outcome. */
export function writeScopeMeta(input: ScopeMetaInput, writer: ScopeMetaWriter, now = new Date()): void {
  try {
    const commentCount = Object.values(input.file.branches).reduce((count, branch) => count + branch.threads.length, 0);
    writer.writeAtomic(
      path.join(input.scopeDirectory, 'meta.json'),
      JSON.stringify({
        scopeId: input.scopeId,
        lastKnownPath: input.folderPath,
        label: path.basename(input.folderPath),
        commentCount,
        updatedAt: now.toISOString(),
      }),
    );
  } catch {
    // Metadata is advisory and must never turn a successful comment save into a failure.
  }
}
