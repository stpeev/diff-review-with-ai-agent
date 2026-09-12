import { resolveBinding, type AgentSession } from '../../agent-registry';

export interface AgentSessionSelectionDeps<Session extends AgentSession> {
  sessions(): Session[];
  getBoundSessionId(): string | undefined;
  setBoundSessionId(sessionId: string | undefined): Thenable<void>;
  pick(sessions: Session[]): Promise<Session | undefined>;
  log(message: string): void;
  sessionName(session: Session): string;
}

/** Select a registered session, preserving a valid explicit binding when possible. */
export async function selectAgentSession<Session extends AgentSession>(
  deps: AgentSessionSelectionDeps<Session>,
  forcePicker = false,
): Promise<Session | undefined> {
  const sessions = deps.sessions();
  if (sessions.length === 0) return undefined;
  const boundId = deps.getBoundSessionId();
  const automatic = !forcePicker ? resolveBinding(sessions, boundId) : undefined;
  if (automatic) {
    if (automatic.sessionId !== boundId) await deps.setBoundSessionId(automatic.sessionId);
    deps.log(
      `Selected agent session ${deps.sessionName(automatic)} (${automatic.sessionId === boundId ? 'remembered binding' : 'only available session'})`,
    );
    return automatic;
  }
  const picked = await deps.pick(sessions);
  if (!picked) {
    deps.log('Agent session selection cancelled');
    return undefined;
  }
  await deps.setBoundSessionId(picked.sessionId);
  deps.log(`Selected agent session ${deps.sessionName(picked)} (manual selection)`);
  return picked;
}
