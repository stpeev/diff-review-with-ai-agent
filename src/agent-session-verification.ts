export interface ClaudeSessionIdentity {
  pid?: number;
  socketPath?: string;
  token?: string;
}

export interface ClaudeSessionVerificationDeps {
  pidFromSocketPath(socketPath: string): number | undefined;
  processExists(pid: number): boolean;
  socketOwnerUid(socketPath: string): number | undefined;
  currentUid(): number | undefined;
}

export type ClaudeSessionVerificationResult = { ok: true; pid: number } | { ok: false };

/** Verify that the registered Claude socket belongs to the claimed local process and current user. */
export function verifyClaudeSessionIdentity(
  session: ClaudeSessionIdentity,
  deps: ClaudeSessionVerificationDeps,
): ClaudeSessionVerificationResult {
  const socketPath = session.socketPath ?? '';
  const socketPid = deps.pidFromSocketPath(socketPath);
  const pid = session.pid ?? socketPid;
  if (pid === undefined || pid !== socketPid || typeof session.token !== 'string' || session.token.length === 0) {
    return { ok: false };
  }
  try {
    if (!deps.processExists(pid) || deps.socketOwnerUid(socketPath) !== deps.currentUid()) return { ok: false };
    return { ok: true, pid };
  } catch {
    return { ok: false };
  }
}
