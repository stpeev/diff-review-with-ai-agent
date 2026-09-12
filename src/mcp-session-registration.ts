import { claudePidFromSocketPath } from './agent-registry';
import { claudeSessionLabel, codexSessionLabel, normalizeAgentLabel } from './agent-label';

export interface RegistrationOutcome {
  ok: boolean;
  error?: string;
  label?: string;
}

export interface McpSessionRegistrationDependencies {
  post(route: string, body: Record<string, unknown>): Promise<unknown>;
  log(message: string): void;
  environment: NodeJS.ProcessEnv;
  cwd(): string;
  claudePidFromSocketPath(socketPath: string | undefined): number | undefined;
  claudeSessionLabel(pid: number | undefined, sessionId: string): string | undefined;
  codexSessionLabel(sessionId: string): string | undefined;
}

export interface McpSessionRegistrar {
  registerCodexSession(sessionId: string, requestedLabel?: string): Promise<RegistrationOutcome>;
  registerClaudeSession(sessionId: string, requestedLabel?: string): Promise<RegistrationOutcome>;
  clear(sessionId: string): void;
}

export function createMcpSessionRegistrar(dependencies: McpSessionRegistrationDependencies): McpSessionRegistrar {
  const codexRegistrations = new Map<string, Promise<RegistrationOutcome>>();
  const claudeRegistrations = new Map<string, Promise<RegistrationOutcome>>();

  function registerCodexSession(sessionId: string, requestedLabel?: string): Promise<RegistrationOutcome> {
    const humanLabel = normalizeAgentLabel(requestedLabel);
    const existing = humanLabel ? undefined : codexRegistrations.get(sessionId);
    if (existing) return existing;

    const sessionName = `codex:${sessionId.slice(-6)}`;
    const label = humanLabel ?? dependencies.codexSessionLabel(sessionId) ?? `Codex ${sessionId.slice(-6)}`;
    const registration = (async () => {
      dependencies.log(`Registering agent session ${sessionName} with the workspace extension`);
      try {
        await dependencies.post('/session/register', { agent: 'codex', sessionId, cwd: dependencies.cwd(), label });
        dependencies.log(`Registered agent session ${sessionName}`);
        return { ok: true, label };
      } catch (error: any) {
        codexRegistrations.delete(sessionId);
        const message = error.message ?? String(error);
        dependencies.log(`Session registration failed for ${sessionName}: ${message}`);
        return { ok: false, error: message };
      }
    })();
    codexRegistrations.set(sessionId, registration);
    return registration;
  }

  function registerClaudeSession(sessionId: string, requestedLabel?: string): Promise<RegistrationOutcome> {
    const humanLabel = normalizeAgentLabel(requestedLabel);
    const existing = humanLabel ? undefined : claudeRegistrations.get(sessionId);
    if (existing) return existing;

    const socketPath = dependencies.environment.CLAUDE_CODE_MESSAGING_SOCKET;
    const pid = dependencies.environment.CLAUDE_PID
      ? Number(dependencies.environment.CLAUDE_PID)
      : dependencies.claudePidFromSocketPath(socketPath);
    const cwd = dependencies.environment.CLAUDE_PROJECT_DIR || dependencies.cwd();
    const sessionName = `claude:${sessionId.slice(-6)}`;
    const label = humanLabel ?? dependencies.claudeSessionLabel(pid, sessionId) ?? `Claude ${sessionId.slice(-6)}`;
    const registration = (async () => {
      dependencies.log(
        `Claude messaging context for ${sessionName}: ` +
          `socket=${socketPath ? 'present' : 'missing'}, ` +
          `token=${dependencies.environment.CLAUDE_CODE_MESSAGING_TOKEN ? 'present' : 'missing'}, ` +
          `pid=${pid ?? 'unavailable'}, project=${cwd}`,
      );
      dependencies.log(`Registering agent session ${sessionName} (${label}) with the workspace extension`);
      try {
        await dependencies.post('/session/register', {
          agent: 'claude',
          sessionId,
          cwd,
          label,
          socketPath,
          token: dependencies.environment.CLAUDE_CODE_MESSAGING_TOKEN,
          pid,
        });
        dependencies.log(`Registered agent session ${sessionName} (${label})`);
        return { ok: true, label };
      } catch (error: any) {
        claudeRegistrations.delete(sessionId);
        const message = error.message ?? String(error);
        dependencies.log(`Session registration failed for ${sessionName}: ${message}`);
        return { ok: false, error: message, label };
      }
    })();
    claudeRegistrations.set(sessionId, registration);
    return registration;
  }

  return {
    registerCodexSession,
    registerClaudeSession,
    clear(sessionId) {
      codexRegistrations.delete(sessionId);
      claudeRegistrations.delete(sessionId);
    },
  };
}

export function defaultMcpSessionRegistrationDependencies(
  post: McpSessionRegistrationDependencies['post'],
  log: McpSessionRegistrationDependencies['log'],
): McpSessionRegistrationDependencies {
  return {
    post,
    log,
    environment: process.env,
    cwd: () => process.cwd(),
    claudePidFromSocketPath,
    claudeSessionLabel,
    codexSessionLabel,
  };
}
