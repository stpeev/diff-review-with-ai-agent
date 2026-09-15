import type * as http from 'node:http';
import type { AgentSessionRouteDeps } from '../../protocol/agent-session-routes';
import { handleAgentSessionRoute } from '../../protocol/agent-session-routes';
import type { CreateReviewRouteDeps } from '../../protocol/create-review-route';
import { handleCreateReviewRoute } from '../../protocol/create-review-route';
import type { IpcReadRouteDeps } from '../../protocol/read-routes';
import { handleIpcReadRoute } from '../../protocol/read-routes';
import { RequestBodyTooLargeError } from '../../protocol/body';
import { serveAwaitReview } from '../../protocol/review-await';
import type { ReviewMutationRouteDeps } from '../../protocol/review-mutation-routes';
import { handleReviewMutationRoute } from '../../protocol/review-mutation-routes';
import type { ReviewWaiters } from '../../protocol/review-waiters';

export interface IpcRequestHandlerDeps<Thread, Comment, Health> {
  reads: IpcReadRouteDeps<Comment, Health>;
  sessions: AgentSessionRouteDeps;
  mutations: ReviewMutationRouteDeps<Thread>;
  creates: CreateReviewRouteDeps;
  waiters: ReviewWaiters;
  readBody(request: http.IncomingMessage): Promise<string>;
  workspaceRoots(): string[];
  log(message: string): void;
}

function send(response: http.ServerResponse, status: number, body: object): void {
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

function sendWorkspaceMismatch(response: http.ServerResponse, workspaceRoots: string[]): void {
  send(response, 409, { error: 'workspace mismatch', have: workspaceRoots });
}

/** Adapt HTTP requests to the protocol routes, keeping VS Code state outside the transport boundary. */
export function createIpcRequestHandler<Thread, Comment, Health>(
  deps: IpcRequestHandlerDeps<Thread, Comment, Health>,
): http.RequestListener {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Access-Control-Allow-Origin', 'localhost');

    const url = new URL(request.url || '/', 'http://localhost');
    const method = request.method || 'GET';
    try {
      const readRoute = method === 'GET' ? handleIpcReadRoute(url.pathname, deps.reads) : undefined;
      if (readRoute) {
        if (url.pathname === '/comments') {
          const threads = (readRoute.body as { threads: unknown[] }).threads;
          deps.log(`Comments listed via IPC (${threads.length} thread(s))`);
        }
        send(response, readRoute.status, readRoute.body);
      } else if (method === 'GET' && url.pathname === '/review/await') {
        const since = Number(url.searchParams.get('since') ?? 0);
        serveAwaitReview(request, response, deps.waiters, since, { log: deps.log });
      } else if (method === 'POST' && ['/session/register', '/session/unregister'].includes(url.pathname)) {
        const result = await handleAgentSessionRoute(url.pathname, await deps.readBody(request), deps.sessions);
        if (!result) throw new Error(`No session route for ${url.pathname}`);
        if (result.status === 409) sendWorkspaceMismatch(response, deps.workspaceRoots());
        else send(response, result.status, result.body);
      } else if (method === 'POST' && url.pathname === '/create') {
        const result = handleCreateReviewRoute(await deps.readBody(request), deps.creates);
        if (result.status === 409) sendWorkspaceMismatch(response, deps.workspaceRoots());
        else send(response, result.status, result.body);
      } else if (method === 'POST' && ['/reply', '/resolve', '/unresolve', '/delete'].includes(url.pathname)) {
        const result = handleReviewMutationRoute(url.pathname, await deps.readBody(request), deps.mutations);
        if (!result) throw new Error(`No review mutation route for ${url.pathname}`);
        if (result.status === 409) {
          sendWorkspaceMismatch(response, deps.workspaceRoots());
          return;
        }
        if (result.status === 200) {
          const description =
            result.action === 'delete'
              ? `deleted via IPC${result.drifted ? ' (drifted)' : ''}`
              : result.action === 'reply'
                ? `updated (agent reply via IPC${result.drifted ? ', drifted' : ''})`
                : `updated (${result.action === 'resolve' ? 'resolved' : 'unresolved'} via IPC${result.drifted ? ', drifted' : ''})`;
          deps.log(`Comment #${result.threadId} ${description} at ${result.location ?? 'unknown location'}`);
        }
        send(response, result.status, result.body);
      } else {
        send(response, 404, { error: 'Not found' });
      }
    } catch (error: unknown) {
      send(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
