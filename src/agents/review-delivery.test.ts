import { expect, test, vi } from 'vitest';
import { deliverReviewOrFallback } from './review-delivery';

const session = { agent: 'claude', sessionId: 'session-123456', label: 'Topic review' };

function dependencies() {
  return {
    hasSessions: vi.fn(() => true),
    selectSession: vi.fn(async () => session),
    buildPrompt: vi.fn(async () => 'review prompt'),
    directTools: 'direct',
    fallbackTools: 'fallback',
    deliver: vi.fn(async () => 'accepted by socket'),
    sessionName: (selected: typeof session) => `${selected.agent}:${selected.sessionId.slice(-6)}`,
    announceQueuedReview: vi.fn(),
    log: vi.fn(),
    openChat: vi.fn(async () => undefined),
    writeClipboard: vi.fn(async () => undefined),
    showInformation: vi.fn(),
    showWarning: vi.fn(),
  };
}

test('uses direct delivery when a selected session is available', async () => {
  const deps = dependencies();

  await deliverReviewOrFallback([{ id: 1 }], deps);

  expect(deps.buildPrompt).toHaveBeenCalledWith([{ id: 1 }], 'direct');
  expect(deps.deliver).toHaveBeenCalledWith(session, 'review prompt');
  expect(deps.showInformation).toHaveBeenCalledWith('Diff Review sent to Topic review — accepted by socket');
  expect(deps.log).toHaveBeenLastCalledWith('Direct delivery to claude:123456 accepted');
});

test('queues a review when direct delivery fails', async () => {
  const deps = dependencies();
  deps.deliver.mockRejectedValueOnce(new Error('socket lost'));

  await deliverReviewOrFallback([{ id: 1 }], deps);

  expect(deps.announceQueuedReview).toHaveBeenCalledOnce();
  expect(deps.showWarning).toHaveBeenCalledWith(
    "Review queued for Topic review; direct delivery failed. It will arrive on the agent's next awaitReview poll.",
  );
});

test('uses chat then clipboard fallback without a registered session', async () => {
  const deps = dependencies();
  deps.hasSessions.mockReturnValue(false);
  deps.openChat.mockRejectedValueOnce(new Error('chat unavailable'));

  await deliverReviewOrFallback([{ id: 1 }, { id: 2 }], deps);

  expect(deps.buildPrompt).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }], 'fallback');
  expect(deps.writeClipboard).toHaveBeenCalledWith('review prompt');
  expect(deps.showInformation).toHaveBeenCalledWith('Prompt with 2 comment(s) copied to clipboard.');
});
