import type { AgentKind, AgentSession } from '../agent-registry';
import { parseIpcRequest, sessionRegisterRequestSchema, sessionUnregisterRequestSchema } from './contracts';

type SessionRegistration = Omit<AgentSession, 'registeredAt' | 'lastSeenAt'>;

export interface AgentSessionRegistry {
  get(sessionId: string): AgentSession | undefined;
  remove(sessionId: string): void;
  register(session: SessionRegistration): AgentSession;
  list(): AgentSession[];
}

export interface AgentSessionRouteDeps {
  workspaceMatches(expectedRoot: string | undefined): boolean;
  cwdInWorkspace(cwd: string): boolean;
  clearBoundSession(sessionId: string): Promise<void>;
  verifyClaudeSession(input: { pid?: number; socketPath?: string; token?: string }): boolean;
  claudePidFromSocketPath(socketPath: string | undefined): number | undefined;
  sessions: AgentSessionRegistry;
  log(message: string): void;
}

export type AgentSessionRouteResult =
  | { status: 200; body: { ok: true; removed?: boolean } }
  | { status: 400; body: { error: string } }
  | { status: 409; body: { error: 'workspace mismatch' } };

/** Handle the session routes without coupling protocol validation to VS Code or HTTP response objects. */
export async function handleAgentSessionRoute(
  pathname: string,
  body: string,
  deps: AgentSessionRouteDeps,
): Promise<AgentSessionRouteResult | undefined> {
  if (pathname === '/session/unregister') {
    const { expectWorkspaceRoot, sessionId } = parseIpcRequest(body, sessionUnregisterRequestSchema);
    if (!deps.workspaceMatches(expectWorkspaceRoot)) return { status: 409, body: { error: 'workspace mismatch' } };

    const session = deps.sessions.get(sessionId);
    deps.sessions.remove(sessionId);
    await deps.clearBoundSession(sessionId);
    deps.log(
      `Unregistered agent session ${session ? `${session.label} [${session.agent}:${session.sessionId.slice(-6)}]` : sessionId.slice(-6)} (${deps.sessions.list().length} active session(s))`,
    );
    return { status: 200, body: { ok: true, removed: session !== undefined } };
  }

  if (pathname !== '/session/register') return undefined;
  const data = parseIpcRequest(body, sessionRegisterRequestSchema);
  if (!deps.workspaceMatches(data.expectWorkspaceRoot) || !deps.cwdInWorkspace(data.cwd)) {
    deps.log('Rejected agent session registration: workspace mismatch');
    return { status: 409, body: { error: 'workspace mismatch' } };
  }
  if (data.agent === 'claude' && !deps.verifyClaudeSession(data)) {
    deps.log(`Rejected Claude session ${data.sessionId.slice(-6)}: identity verification failed`);
    return { status: 400, body: { error: 'Claude session identity could not be verified' } };
  }

  const session = deps.sessions.register({
    agent: data.agent as AgentKind,
    sessionId: data.sessionId,
    label: data.label || `${data.agent}-${data.sessionId.slice(-6)}`,
    cwd: data.cwd,
    socketPath: data.socketPath,
    token: data.token,
    pid: data.agent === 'claude' ? deps.claudePidFromSocketPath(data.socketPath) : data.pid,
  });
  deps.log(
    `Registered agent session ${session.label} [${session.agent}:${session.sessionId.slice(-6)}] (${deps.sessions.list().length} active session(s))`,
  );
  return { status: 200, body: { ok: true } };
}
