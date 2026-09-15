export interface ReviewDeliverySession {
  agent: string;
  sessionId: string;
  label: string;
}

export interface ReviewDeliveryDeps<Thread, Session extends ReviewDeliverySession> {
  hasSessions(): boolean;
  selectSession(): Promise<Session | undefined>;
  buildPrompt(threads: Thread[], tools: unknown): Promise<string>;
  directTools: unknown;
  fallbackTools: unknown;
  deliver(session: Session, prompt: string): Promise<string>;
  sessionName(session: Session): string;
  announceQueuedReview(): void;
  log(message: string): void;
  openChat(prompt: string): Thenable<unknown>;
  writeClipboard(prompt: string): Thenable<void>;
  showInformation(message: string): unknown;
  showWarning(message: string): unknown;
}

/**
 * Deliver review prompts directly when an agent session is available, with a
 * clear fallback for delivery failure and for VS Code chat unavailability.
 * Delivery acceptance is deliberately kept separate from the agent addressing
 * the review.
 */
export async function deliverReviewOrFallback<Thread, Session extends ReviewDeliverySession>(
  targetThreads: Thread[],
  deps: ReviewDeliveryDeps<Thread, Session>,
): Promise<void> {
  const count = targetThreads.length;
  if (deps.hasSessions()) {
    const session = await deps.selectSession();
    if (!session) return;
    try {
      const prompt = await deps.buildPrompt(targetThreads, deps.directTools);
      deps.log(`Delivering ${count} review comment(s) to ${deps.sessionName(session)}`);
      const outcome = await deps.deliver(session, prompt);
      deps.log(`Direct delivery to ${deps.sessionName(session)} accepted`);
      deps.showInformation(`Diff Review sent to ${session.label}${outcome ? ` — ${outcome}` : ''}`);
    } catch (error: any) {
      deps.announceQueuedReview();
      deps.log(
        `Direct delivery to ${deps.sessionName(session)} failed: ${error.message ?? error}; review remains queued for awaitReview`,
      );
      deps.showWarning(
        `Review queued for ${session.label}; direct delivery failed. It will arrive on the agent's next awaitReview poll.`,
      );
    }
    return;
  }

  const prompt = await deps.buildPrompt(targetThreads, deps.fallbackTools);
  deps.log(`No registered agent session; opening chat with ${count} review comment(s)`);
  try {
    await deps.openChat(prompt);
    deps.log('Review prompt opened in chat');
  } catch {
    await deps.writeClipboard(prompt);
    deps.log('Chat could not be opened; review prompt copied to clipboard');
    deps.showInformation(`Prompt with ${count} comment(s) copied to clipboard.`);
  }
}
