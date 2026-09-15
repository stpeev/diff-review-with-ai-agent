export interface IpcReadRouteDeps<Comment, Health> {
  workspaceRoots(): string[];
  processId(): number;
  comments(): Comment[];
  health(): Health;
}

export type IpcReadRouteResult = { status: 200; body: object } | undefined;

/** Serve read-only IPC DTOs without coupling their wire shape to VS Code. */
export function handleIpcReadRoute<Comment, Health>(
  pathname: string,
  deps: IpcReadRouteDeps<Comment, Health>,
): IpcReadRouteResult {
  if (pathname === '/ping') {
    return { status: 200, body: { workspaceRoots: deps.workspaceRoots(), pid: deps.processId() } };
  }
  if (pathname === '/comments') return { status: 200, body: { threads: deps.comments() } };
  if (pathname === '/health') return { status: 200, body: { ok: true, ...deps.health() } };
  return undefined;
}
