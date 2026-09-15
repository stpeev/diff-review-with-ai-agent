export interface ScopeFileWatcher {
  onDidChange(listener: () => void): unknown;
  onDidCreate(listener: () => void): unknown;
  dispose(): void;
}

export interface ScopeFileWatcherDeps<File> {
  createWatcher(filePath: string): ScopeFileWatcher;
  filePath: string;
  folderPath: string;
  folderName: string;
  suppressWatcherUntil(): number | undefined;
  now(): number;
  read(): File;
  replaceVisibleThreads(file: File): void;
  refresh(): void;
  log(message: string): void;
  showError(message: string): void;
}

/**
 * Watch a persisted scope file without ever replacing a valid visible review
 * with unreadable external data.
 */
export function watchScopeFile<File>(deps: ScopeFileWatcherDeps<File>): ScopeFileWatcher {
  const watcher = deps.createWatcher(deps.filePath);
  const reload = () => {
    const suppressUntil = deps.suppressWatcherUntil();
    if (suppressUntil !== undefined && deps.now() < suppressUntil) return;
    deps.log(`[Diff Review] ${deps.folderPath}: external change to ${deps.filePath}, reloading`);
    try {
      const file = deps.read();
      deps.replaceVisibleThreads(file);
      deps.refresh();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.log(`[Diff Review] Ignored unreadable external comments update for ${deps.folderPath}: ${detail}`);
      deps.showError(
        `Diff Review: could not reload comments for ${deps.folderName}. Existing comments remain visible.`,
      );
    }
  };
  watcher.onDidChange(reload);
  watcher.onDidCreate(reload);
  return watcher;
}
