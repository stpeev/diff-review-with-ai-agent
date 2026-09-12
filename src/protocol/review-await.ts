import type * as http from 'node:http';
import { ReviewWaiters } from './review-waiters';

export interface AwaitReviewOptions {
  timeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Serve one long-poll request for the next review generation. Disconnects
 * always unsubscribe the request so an abandoned HTTP response cannot leak a
 * waiter into later review notifications.
 */
export function serveAwaitReview(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  waiters: ReviewWaiters,
  since: number,
  options: AwaitReviewOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const log = options.log ?? (() => undefined);
  const respond = (payload: { pending: boolean; generation: number }) => {
    response.writeHead(200);
    response.end(JSON.stringify(payload));
  };

  if (waiters.generation > since) {
    log(`awaitReview found pending generation ${waiters.generation}`);
    respond({ pending: true, generation: waiters.generation });
    return;
  }

  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: () => void = () => undefined;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
    request.off('aborted', cancel);
    request.off('close', cancel);
    response.off('close', cancel);
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };
  const done = (generation: number) => {
    if (settled) return;
    settled = true;
    cleanup();
    log(`awaitReview released for generation ${generation}`);
    respond({ pending: true, generation });
  };

  unsubscribe = waiters.subscribe(done);
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    respond({ pending: false, generation: waiters.generation });
  }, timeoutMs);
  request.once('aborted', cancel);
  request.once('close', cancel);
  response.once('close', cancel);
}
