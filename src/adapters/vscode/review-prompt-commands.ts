export interface PromptCommandRegistrationDeps<Thread> {
  registerCommand(command: string, callback: (...args: any[]) => unknown): { dispose(): unknown };
  allLiveThreads(): Thread[];
  threadsForFile(fileKey: string): Thread[] | undefined;
  isOpen(thread: Thread): boolean;
  buildPrompt(threads: Thread[]): Promise<string>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  writeClipboard(text: string): Thenable<void>;
  showInformation(message: string): unknown;
}

/** Register prompt submission and clipboard commands without embedding their flow in extension activation. */
export function registerReviewPromptCommands<Thread>(
  subscriptions: { dispose(): unknown }[],
  deps: PromptCommandRegistrationDeps<Thread>,
): void {
  subscriptions.push(
    deps.registerCommand('diffReview.submitFile', async (fileKey: string) => {
      const openThreads = (deps.threadsForFile(fileKey) ?? []).filter(deps.isOpen);
      if (openThreads.length === 0) {
        deps.showInformation('No open comments in this file.');
        return;
      }
      const prompt = await deps.buildPrompt(openThreads);
      try {
        await deps.executeCommand('workbench.action.chat.open', { query: prompt });
      } catch {
        await deps.writeClipboard(prompt);
        deps.showInformation('Prompt copied to clipboard.');
      }
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.copyThread', async (thread: Thread) => {
      await deps.writeClipboard(await deps.buildPrompt([thread]));
      deps.showInformation('Comment prompt copied to clipboard.');
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.copyAll', async () => {
      const openThreads = deps.allLiveThreads().filter(deps.isOpen);
      if (openThreads.length === 0) {
        deps.showInformation('No open comments to copy.');
        return;
      }
      await deps.writeClipboard(await deps.buildPrompt(openThreads));
      deps.showInformation(`${openThreads.length} comment(s) copied to clipboard.`);
    }),
  );
  subscriptions.push(
    deps.registerCommand('diffReview.copyFile', async (fileKey: string) => {
      const openThreads = (deps.threadsForFile(fileKey) ?? []).filter(deps.isOpen);
      if (openThreads.length === 0) {
        deps.showInformation('No open comments in this file.');
        return;
      }
      await deps.writeClipboard(await deps.buildPrompt(openThreads));
      deps.showInformation(`${openThreads.length} comment(s) from ${fileKey} copied to clipboard.`);
    }),
  );
}
